const supabase = require('../../config/supabase')
const slaCalculationService = require('../../services/slaCalculationService')
const supervisaoService = require('../../services/supervisaoService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const { loadChatbotTriageMergeAndAbsence } = require('../../services/absenceFinalizationService')
const { isGroupRow } = require('../../helpers/departamentoGruposHelper')
const {
  SAO_PAULO_TZ,
  clampInt,
  fetchAllRows,
  fetchUsuariosNomeMap,
  saoPauloDateStartIso,
  saoPauloDateEndIso,
  todaySaoPauloDateKey,
  addDaysDateKey,
  chunkArray,
} = require('./helpers')

/**
 * "Clientes com conversa hoje": clientes distintos (não-grupo) com ao menos uma
 * mensagem real (in/out) hoje, no fuso America/Sao_Paulo. NÃO é contagem da tabela
 * `atendimentos` (que registra movimentações, não presença de conversa).
 */
async function countClientesComConversaHoje(company_id) {
  const inicioHojeIso = saoPauloDateStartIso(todaySaoPauloDateKey())
  const msgs = await fetchAllRows(() =>
    supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .gte('criado_em', inicioHojeIso)
  )
  const convIds = [...new Set((msgs || []).map((m) => m?.conversa_id).filter((x) => x != null))]
  if (!convIds.length) return 0
  let total = 0
  for (const chunk of chunkArray(convIds, 200)) {
    const { data, error } = await supabase
      .from('conversas')
      .select('id, tipo, telefone')
      .eq('company_id', company_id)
      .in('id', chunk)
    if (error) throw error
    for (const c of data || []) {
      if (!isGroupRow(c)) total++
    }
  }
  return total
}

async function overview(req, res) {
  const { company_id } = req.user

  try {
    // Filtro de período (opcional): últimos N dias
    // - Sem range_days → mantém comportamento antigo (tudo)
    // - Com range_days → evita dashboard "pesado" e deixa mais útil
    const rangeDays = clampInt(req.query?.range_days, 1, 365)
    // Janela em DIAS LOCAIS (America/Sao_Paulo), coerente com "últimos N dias locais, incluindo hoje".
    const dataFim = todaySaoPauloDateKey()
    const dataInicio = rangeDays ? addDaysDateKey(dataFim, -(rangeDays - 1)) : null
    const fromIso = dataInicio ? saoPauloDateStartIso(dataInicio) : null
    const toIso = saoPauloDateEndIso(dataFim)

    /* ===============================
       1. STATUS DAS CONVERSAS (KPIs)
    =============================== */
    const conversas = await fetchAllRows(() => {
      let q = supabase
        .from('conversas')
        // Não embute departamentos aqui: em alguns schemas o PostgREST detecta mais de 1 relacionamento
        // e quebra com "Could not embed because more than one relationship was found..."
        .select('status_atendimento, criado_em, atendente_id, departamento_id')
        .eq('company_id', company_id)
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    const kpis = {
      total: conversas.length,
      abertas: 0,
      em_atendimento: 0,
      fechadas: 0,
      tempo_primeira_resposta_min: null,
      atendimentos_hoje: 0,
      tempo_medio_resposta_min: null,
      sla_percent: null,
      atendente_mais_produtivo: null,
      tickets_abertos: 0,
    }

    conversas.forEach(c => {
      if (c.status_atendimento === 'aberta') kpis.abertas++
      if (c.status_atendimento === 'em_atendimento' || c.status_atendimento === 'aguardando_cliente') kpis.em_atendimento++
      if (c.status_atendimento === 'fechada') kpis.fechadas++
    })

    // Abertas: só contar as que têm movimentação (mensagem ou atendente assumiu)
    const { data: countAbertasComMov, error: errCountAbertas } = await supabase
      .rpc('count_conversas_abertas_com_movimentacao', {
        p_company_id: company_id,
        p_from_iso: fromIso || null,
        p_to_iso: toIso || null
      })
    if (!errCountAbertas && countAbertasComMov != null) {
      kpis.abertas = Number(countAbertasComMov) || 0
    }

    kpis.tickets_abertos = kpis.abertas + kpis.em_atendimento

    // Conversas por setor (departamento) — resolve nomes manualmente (sem embed)
    const setorMap = {}
    const depIds = [...new Set((conversas || []).map((c) => c?.departamento_id).filter((id) => id != null))]
    let depMap = {}
    if (depIds.length > 0) {
      const { data: deps, error: errDeps } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', depIds)
      if (!errDeps && Array.isArray(deps)) {
        deps.forEach((d) => {
          if (d?.id != null) depMap[String(d.id)] = d?.nome || null
        })
      }
    }
    for (const c of conversas || []) {
      const depId = c?.departamento_id
      const nome = depId != null ? (depMap[String(depId)] || 'Sem setor') : 'Sem setor'
      setorMap[nome] = (setorMap[nome] || 0) + 1
    }
    const conversas_por_setor = Object.entries(setorMap)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)

    /* ===============================
       CLIENTES COM CONVERSA HOJE (clientes distintos com msg real hoje)
    =============================== */
    try {
      kpis.atendimentos_hoje = await countClientesComConversaHoje(company_id)
    } catch (e) {
      console.error('[overview] clientes com conversa hoje falhou:', e?.message || e)
    }

    /* ===============================
       2. TEMPO MÉDIO DA 1ª RESPOSTA (SLA)
    =============================== */
    const mensagens = await fetchAllRows(() => {
      let q = supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao, tipo, autor_usuario_id, texto, whatsapp_id, whatsapp_instance_id')
        .eq('company_id', company_id)
        .in('direcao', ['in', 'out'])
        .order('criado_em', { ascending: true })
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    // Origem da mensagem enviada + deduplicação por whatsapp_id + trilha de auditoria.
    // Origem (outbound): autor_usuario_id != null → sistema (humano no ZapERP);
    // null + texto humano → celular (espelho fromMe do WhatsApp Web); null + texto de bot → automação.
    const triageOverview = await loadChatbotTriageMergeAndAbsence(company_id).catch(() => null)

    const msgTipoMap = {}
    let msgIn = 0
    let msgOut = 0
    const origens = { sistema_humano: 0, whatsapp_celular: 0, automacao: 0, bot: 0 }
    let dupExcluidas = 0
    let invalidExcluidas = 0
    let legadasSemInstancia = 0
    const whatsappIdsVistos = new Set()

    for (const msg of mensagens || []) {
      if (!msg?.criado_em) { invalidExcluidas++; continue }
      const wid = msg?.whatsapp_id != null ? String(msg.whatsapp_id) : ''
      if (wid) {
        if (whatsappIdsVistos.has(wid)) { dupExcluidas++; continue }
        whatsappIdsVistos.add(wid)
      }
      if (msg?.whatsapp_instance_id == null) legadasSemInstancia++

      const t = String(msg?.tipo || 'texto').toLowerCase()
      msgTipoMap[t] = (msgTipoMap[t] || 0) + 1
      if (msg?.direcao === 'in') {
        msgIn++
      } else if (msg?.direcao === 'out') {
        msgOut++
        if (msg?.autor_usuario_id != null) origens.sistema_humano++
        else if (supervisaoService.outboundEhRespostaHumana(msg, triageOverview)) origens.whatsapp_celular++
        else origens.automacao++
      }
    }

    // Tempo de resposta + SLA% saem do MOTOR DE SLA (mesma lógica da aba SLA):
    // só resposta humana, horário comercial e almoço (12:00–14:00) excluídos.
    // Assim os dois cards deixam de ser idênticos, o bot não conta como resposta,
    // e a Visão geral passa a bater com a aba SLA. Isolado em try/catch para não
    // derrubar o dashboard inteiro caso o cálculo falhe.
    let horario_comercial = null
    try {
      const slaAnalytics = await slaCalculationService.buildSlaAnalytics(
        company_id,
        { data_inicio: dataInicio || '2000-01-01', data_fim: dataFim },
        { skipTrend: true }
      )
      const r = slaAnalytics?.resumo || {}
      kpis.tempo_primeira_resposta_min =
        r.tempo_medio_primeira_resposta_min != null ? Math.round(r.tempo_medio_primeira_resposta_min) : null
      kpis.tempo_medio_resposta_min =
        r.tempo_medio_resposta_min != null ? Math.round(r.tempo_medio_resposta_min * 10) / 10 : null
      kpis.sla_percent = r.percentual_cumprido != null ? Math.round(r.percentual_cumprido) : null
      kpis.sla_conta_automacao = slaAnalytics?.config?.sla_contar_bot_como_resposta === true
      // Horário/dias REALMENTE usados no cálculo (para o admin certificar a configuração).
      const bi = slaAnalytics?.horario_comercial || null
      kpis.sla_horario_comercial_ativo = slaAnalytics?.config?.sla_usar_horario_comercial === true
      horario_comercial = bi ? {
        ativo: bi.horario_comercial_ativo === true,
        modo_contagem: bi.modo_contagem || null,
        resumo: bi.resumo || null,
        intervalo_almoco: bi.intervalo_almoco || null,
        janelas: (bi.schedule?.windows || []).map((w) => ({
          inicio: `${String(Math.floor(w.start / 60)).padStart(2, '0')}:${String(w.start % 60).padStart(2, '0')}`,
          fim: `${String(Math.floor(w.end / 60)).padStart(2, '0')}:${String(w.end % 60).padStart(2, '0')}`,
        })),
        dias_semana_desativados: bi.schedule?.diasSemanaDesativados || [],
      } : null
    } catch (e) {
      console.error('[overview] cálculo de SLA/tempo de resposta falhou:', e?.message || e)
    }

    const mensagens_por_tipo = Object.entries(msgTipoMap)
      .map(([tipo, total]) => ({ tipo, total }))
      .sort((a, b) => b.total - a.total)

    // Total já deduplicado por whatsapp_id (in + out), coerente com "por tipo" e "origens".
    const mensagens_kpis = {
      total: msgIn + msgOut,
      in: msgIn,
      out: msgOut,
      origens,
    }

    /* ===============================
       3. CONVERSAS POR ATENDENTE + ATENDENTE MAIS PRODUTIVO
    =============================== */
    const porAtendente = await fetchAllRows(() => {
      let q = supabase
        .from('conversas')
        .select('atendente_id')
        .eq('company_id', company_id)
        .not('atendente_id', 'is', null)
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    const usuarioNomeMap = await fetchUsuariosNomeMap(
      company_id,
      (porAtendente || []).map((c) => c?.atendente_id)
    )

    const atendentesMap = {}

    porAtendente.forEach((c) => {
      const nome = usuarioNomeMap[String(c?.atendente_id)] || 'Sem nome'
      atendentesMap[nome] = (atendentesMap[nome] || 0) + 1
    })

    const conversasPorAtendente = Object.entries(atendentesMap).map(
      ([nome, total]) => ({
        nome,
        total,
      })
    )

    if (conversasPorAtendente.length > 0) {
      const top = conversasPorAtendente.sort((a, b) => b.total - a.total)[0]
      kpis.atendente_mais_produtivo = top?.nome ?? null
    }

    /* ===============================
       4. CONVERSAS POR HORA
    =============================== */
    const porHoraMap = {}

    conversas.forEach(c => {
      const hora = new Date(c.criado_em).getHours()
      porHoraMap[hora] = (porHoraMap[hora] || 0) + 1
    })

    const conversasPorHora = Object.entries(porHoraMap)
      .map(([hora, total]) => ({
        hora: `${hora.toString().padStart(2, '0')}:00`,
        total,
      }))
      .sort((a, b) => a.hora.localeCompare(b.hora))

    /* ===============================
       5. CONVERSAS POR STATUS (do período)
    =============================== */
    const statusMap = {}
    for (const c of conversas || []) {
      const st = String(c?.status_atendimento || 'sem_status')
      statusMap[st] = (statusMap[st] || 0) + 1
    }
    const conversas_por_status = Object.entries(statusMap)
      .map(([status, total]) => ({ status, total }))
      .sort((a, b) => b.total - a.total)

    /* ===============================
       6. MODO SIMPLES + FILA AO VIVO
    =============================== */
    const modoSimplesAtivo = await empresaModoSimplesAtivo(company_id).catch(() => false)
    kpis.atendimento_modo_simples = modoSimplesAtivo === true
    if (modoSimplesAtivo) {
      try {
        const fila = await supervisaoService.getFilaModoSimplesCounts(company_id)
        kpis.aguardando_atendente = fila.aguardando_atendente
        kpis.aguardando_cliente = fila.aguardando_cliente
      } catch (e) {
        console.error('[overview] fila modo simples falhou:', e?.message || e)
      }
    }

    // crm_leads foi dropado (CRM interno removido). Campo preservado no JSON da API.
    kpis.taxa_conversao_percent = null

    /* ===============================
       8. INSTÂNCIA PRINCIPAL (nome exibido no cabeçalho)
    =============================== */
    let instancia = null
    try {
      const { data: inst } = await supabase
        .from('whatsapp_instances')
        .select('id, nome, is_default, status')
        .eq('company_id', company_id)
        .eq('ativo', true)
        .order('is_default', { ascending: false })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (inst) instancia = { id: inst.id, nome: inst.nome || 'WhatsApp principal', status: inst.status || null }
    } catch (_) {}

    const auditoria = {
      mensagens_duplicadas_excluidas: dupExcluidas,
      mensagens_invalidas_excluidas: invalidExcluidas,
      mensagens_legadas_sem_instancia: legadasSemInstancia,
    }

    /* ===============================
       RESPONSE FINAL
    =============================== */
    res.json({
      periodo: {
        range_days: rangeDays,
        timezone: SAO_PAULO_TZ,
        data_inicio: dataInicio,
        data_fim: dataFim,
        from: fromIso,
        to: toIso,
      },
      instancia,
      horario_comercial,
      auditoria,
      kpis,
      mensagens_kpis,
      mensagens_por_tipo,
      conversas_por_setor,
      conversas_por_atendente: conversasPorAtendente,
      conversas_por_status,
      conversas_por_hora: conversasPorHora,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao gerar dashboard' })
  }
}

module.exports = { overview }
