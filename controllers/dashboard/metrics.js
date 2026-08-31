const supabase = require('../../config/supabase')
const slaCalculationService = require('../../services/slaCalculationService')
const { isEnabled, FLAGS } = require('../../helpers/featureFlags')
const { todaySaoPauloDateKey } = require('./helpers')

async function metrics(req, res) {
  const { company_id } = req.user

  try {
    const hoje = new Date()
    hoje.setHours(0, 0, 0, 0)
    const hojeIso = hoje.toISOString()

    // 2) Conversas da empresa (base para várias métricas)
    const { data: conversas, error: errConversas } = await supabase
      .from('conversas')
      .select('id, criado_em, status_atendimento, atendente_id')
      .eq('company_id', company_id)

    if (errConversas) throw errConversas

    const totalConversas = conversas?.length || 0
    let conversasHoje = 0
    let ticketsAbertos = 0
    let conversasAbertas = 0
    let conversasEmAtendimento = 0
    let conversasAguardandoCliente = 0
    let conversasFechadas = 0

    const contagemPorAtendente = new Map()

    for (const c of conversas || []) {
      const criadoEm = c?.criado_em ? new Date(c.criado_em) : null
      if (criadoEm && criadoEm >= hoje) conversasHoje++

      if (c.status_atendimento === 'aberta') {
        conversasAbertas++
        ticketsAbertos++
      } else if (c.status_atendimento === 'em_atendimento') {
        conversasEmAtendimento++
        ticketsAbertos++
      } else if (c.status_atendimento === 'aguardando_cliente') {
        conversasAguardandoCliente++
        ticketsAbertos++
      } else if (c.status_atendimento === 'fechada') {
        conversasFechadas++
      }
      if (c.atendente_id != null) {
        const id = Number(c.atendente_id)
        if (!Number.isNaN(id)) {
          contagemPorAtendente.set(id, (contagemPorAtendente.get(id) || 0) + 1)
        }
      }
    }

    // Atendente mais produtivo: mais conversas atribuídas
    let atendenteMaisProdutivo = null
    if (contagemPorAtendente.size > 0) {
      const idsAtendentes = Array.from(contagemPorAtendente.keys())
      const { data: usuarios, error: errUsers } = await supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', idsAtendentes)
      if (errUsers) throw errUsers

      let melhorId = null
      let melhorTotal = -1
      for (const [id, total] of contagemPorAtendente.entries()) {
        if (total > melhorTotal) {
          melhorTotal = total
          melhorId = id
        }
      }
      if (melhorId != null) {
        const usuario = (usuarios || []).find((u) => Number(u.id) === Number(melhorId)) || null
        atendenteMaisProdutivo = usuario
          ? { id: usuario.id, nome: usuario.nome || 'Sem nome', totalConversas: melhorTotal }
          : { id: melhorId, nome: 'Sem nome', totalConversas: melhorTotal }
      }
    }

    // 3) Volume de mensagens — contagem EXATA (head), sem o teto de 1000 linhas do PostgREST.
    const [recRes, envRes] = await Promise.all([
      supabase.from('mensagens').select('id', { count: 'exact', head: true })
        .eq('company_id', company_id).eq('direcao', 'in'),
      supabase.from('mensagens').select('id', { count: 'exact', head: true })
        .eq('company_id', company_id).eq('direcao', 'out'),
    ])
    const mensagensRecebidas = Number(recRes.count) || 0
    const mensagensEnviadas = Number(envRes.count) || 0

    // 4) Tempo de 1ª resposta + SLA via MOTOR DE SLA (só resposta humana, horário
    // comercial e almoço excluídos) — mesma verdade da aba SLA e da Visão geral.
    // Antes: pareava 1º outbound QUALQUER (bot contava) em relógio corrido = número errado.
    let tempoMedioPrimeiraResposta = null
    let slaPercentualRespondidas = null
    let slaPercentualTotal = null
    try {
      const sla = await slaCalculationService.buildSlaAnalytics(
        company_id,
        { data_inicio: '2000-01-01', data_fim: todaySaoPauloDateKey() },
        { skipTrend: true }
      )
      const r = sla?.resumo || {}
      tempoMedioPrimeiraResposta = r.tempo_medio_primeira_resposta_min ?? null
      slaPercentualRespondidas = r.percentual_cumprido ?? null
      slaPercentualTotal = r.total_conversas_com_cliente > 0
        ? Math.round((r.dentro_sla * 1000) / r.total_conversas_com_cliente) / 10
        : null
    } catch (e) {
      console.error('[metrics] cálculo de SLA falhou:', e?.message || e)
    }

    // 4) Atendimentos hoje (ações na tabela atendimentos)
    let atendimentosHoje = 0
    {
      const { data: atRows, error: errAt } = await supabase
        .from('atendimentos')
        .select('id')
        .eq('company_id', company_id)
        .gte('criado_em', hojeIso)
      if (errAt) {
        // mantém o endpoint funcionando mesmo se a tabela ainda não existir
        console.warn('metrics: erro ao ler atendimentosHoje:', errAt.message || errAt)
      } else {
        atendimentosHoje = atRows?.length || 0
      }
    }

    return res.json({
      atendimentosHoje,
      conversasHoje,
      totalConversas,
      conversasAbertas,
      conversasEmAtendimento,
      conversasAguardandoCliente,
      conversasFechadas,
      tempoMedioPrimeiraResposta,
      slaPercentualRespondidas,
      slaPercentualTotal,
      atendenteMaisProdutivo,
      ticketsAbertos,
      mensagensRecebidas,
      mensagensEnviadas,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular métricas do dashboard' })
  }
}

// GET /dashboard/metrics-avancadas — volume_enviado, volume_recebido, taxa_resposta_24h, etc.
async function metricsAvancadas(req, res) {
  if (!isEnabled(FLAGS.FEATURE_METRICAS_AVANCADAS)) {
    return res.status(403).json({ error: 'Métricas avançadas não estão habilitadas' })
  }
  const { company_id } = req.user
  const rangeDays = Math.min(Math.max(Number(req.query.range_days) || 7, 1), 365)
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - rangeDays)
  const fromIso = fromDate.toISOString()
  const toIso = new Date().toISOString()

  try {
    const { data: mensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .gte('criado_em', fromIso)
      .lte('criado_em', toIso)

    let volume_enviado = 0
    let volume_recebido = 0
    const conversasPorHora = {}
    const setoresAcionados = {}

    for (const m of mensagens || []) {
      if (m.direcao === 'out') volume_enviado++
      else volume_recebido++

      const d = m.criado_em ? new Date(m.criado_em) : null
      if (d) {
        const h = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}:00`
        conversasPorHora[h] = (conversasPorHora[h] || 0) + 1
      }
    }

    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, departamento_id, criado_em')
      .eq('company_id', company_id)
      .gte('criado_em', fromIso)

    const { data: deps } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', company_id)
    const depMap = {}
    ;(deps || []).forEach((d) => { depMap[d.id] = d.nome })

    for (const c of conversas || []) {
      if (c.departamento_id != null) {
        const nome = depMap[c.departamento_id] || 'Outros'
        setoresAcionados[nome] = (setoresAcionados[nome] || 0) + 1
      }
    }

    const setores_mais_acionados = Object.entries(setoresAcionados)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)

    const horario_pico = Object.entries(conversasPorHora)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null

    const hojeMenos24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: msgs24h } = await supabase
      .from('mensagens')
      .select('conversa_id, direcao, criado_em')
      .eq('company_id', company_id)
      .gte('criado_em', hojeMenos24h)
      .in('direcao', ['in', 'out'])

    const convsComIn24h = new Set()
    const convsComOut24h = new Set()
    for (const m of msgs24h || []) {
      if (m.direcao === 'in') convsComIn24h.add(m.conversa_id)
      if (m.direcao === 'out') convsComOut24h.add(m.conversa_id)
    }
    let taxa_resposta_24h = null
    if (convsComIn24h.size > 0) {
      let respondidas = 0
      for (const cid of convsComIn24h) {
        if (convsComOut24h.has(cid)) respondidas++
      }
      taxa_resposta_24h = Math.round((respondidas / convsComIn24h.size) * 100)
    }

    const { data: novosContatos } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .gte('criado_em', fromIso)
      .is('departamento_id', null)
    const conversas_novos_contatos = novosContatos?.length || 0

    const { data: alertasSla } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .in('status_atendimento', ['aberta', 'em_atendimento'])
    const alertas_recentes = alertasSla?.length || 0

    return res.json({
      volume_enviado,
      volume_recebido,
      taxa_resposta_24h,
      conversas_novos_contatos,
      setores_mais_acionados,
      horario_pico,
      alertas_recentes,
      range_days: rangeDays,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular métricas avançadas' })
  }
}

module.exports = { metrics, metricsAvancadas }
