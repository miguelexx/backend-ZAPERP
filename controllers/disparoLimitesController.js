/**
 * Controller de Limites — módulo Disparo de Mensagens (Etapa 5).
 * Limites, intervalos, lotes, janelas, fuso, agendamento e simulação.
 * Nunca envia mensagens / nunca chama UltraMSG.
 */

const supabase = require('../config/supabase')
const {
  validarLimitesGlobais,
  validarLimitesInstancia,
  validarJanelas,
  simularDuracao,
  proximoHorarioPermitido,
  estaNaJanela,
  PERFIS,
  FUSO_PADRAO,
  REGRA_RETENTATIVA,
  DateTime,
} = require('../helpers/disparoLimitesHelper')
const { statusPermiteEdicao, mensagemBloqueioEdicao } = require('../helpers/disparoStatusHelper')

// ─── Helpers locais ──────────────────────────────────────────────────────────

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select(
      'id, status, company_id, nome, ' +
      'distribuicao_confirmada, distribuicao_revisao, ' +
      'variacao_confirmada, variacao_revisao, ' +
      'limites_confirmados, limites_revisao',
    )
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    res.status(404).json({ error: 'Campanha não encontrada.' })
    return null
  }
  return data
}


const LIMITES_SELECT = [
  'id', 'company_id', 'campanha_id', 'perfil', 'limite_total',
  'limite_por_hora', 'limite_por_dia', 'intervalo_min_sec', 'intervalo_max_sec',
  'lote_tamanho', 'pausa_lote_min_sec', 'pausa_lote_max_sec',
  'fuso_horario', 'inicio_modo', 'agendado_para', 'data_limite',
  'pausa_auto_desconexao', 'pausa_auto_erros_consecutivos', 'pausa_auto_taxa_falha_pct',
  'confirmada', 'revisao', 'configurado_por', 'criado_em', 'atualizado_em',
].join(', ')

const INST_LIMITES_SELECT = [
  'id', 'company_id', 'campanha_id', 'instancia_id', 'herdar_global',
  'limite_por_hora', 'limite_por_dia', 'intervalo_min_sec', 'intervalo_max_sec',
  'lote_tamanho', 'pausa_lote_min_sec', 'pausa_lote_max_sec', 'janelas_proprias',
  'criado_em', 'atualizado_em',
].join(', ')

const JANELAS_SELECT = [
  'id', 'company_id', 'campanha_id', 'instancia_id',
  'dia_semana', 'hora_inicio', 'hora_fim', 'ativo', 'criado_em',
].join(', ')

function buildDefaultsLimites(campanhaId, companyId) {
  const moderado = PERFIS.moderado
  return {
    campanha_id: campanhaId,
    company_id: companyId,
    perfil: 'moderado',
    limite_total: null,
    limite_por_hora: moderado.limite_por_hora,
    limite_por_dia: moderado.limite_por_dia,
    intervalo_min_sec: moderado.intervalo_min_sec,
    intervalo_max_sec: moderado.intervalo_max_sec,
    lote_tamanho: moderado.lote_tamanho,
    pausa_lote_min_sec: moderado.pausa_lote_min_sec,
    pausa_lote_max_sec: moderado.pausa_lote_max_sec,
    fuso_horario: FUSO_PADRAO,
    inicio_modo: 'imediato',
    agendado_para: null,
    data_limite: null,
    pausa_auto_desconexao: true,
    pausa_auto_erros_consecutivos: 5,
    pausa_auto_taxa_falha_pct: 25,
    confirmada: false,
    revisao: false,
    configurado_por: null,
    persistido: false,
  }
}

async function carregarLimitesGlobais(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_limites')
    .select(LIMITES_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (data) return { ...data, persistido: true }
  return buildDefaultsLimites(campanhaId, companyId)
}

async function carregarOverridesInstancia(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_instancia_limites')
    .select(INST_LIMITES_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (error) throw error
  return data ?? []
}

async function carregarTodasJanelas(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_janelas')
    .select(JANELAS_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('dia_semana', { ascending: true })
    .order('hora_inicio', { ascending: true })
  if (error) throw error
  return data ?? []
}

function separarJanelas(janelas) {
  const globais = []
  const porInstancia = {}
  for (const j of janelas) {
    if (j.instancia_id == null) {
      globais.push(j)
    } else {
      const key = String(j.instancia_id)
      if (!porInstancia[key]) porInstancia[key] = []
      porInstancia[key].push(j)
    }
  }
  return { globais, porInstancia }
}

async function carregarInstanciasCampanha(campanhaId, companyId) {
  const { data: configs, error: cErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id, ordem, ativa')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('ordem', { ascending: true })
  if (cErr) throw cErr

  const ids = (configs ?? []).map((c) => c.instancia_id).filter(Boolean)
  if (!ids.length) return { instancias: [], desconectadas: [] }

  const { data: wa, error: wErr } = await supabase
    .from('whatsapp_instances')
    .select('id, nome, status, ativo, display_phone, telefone_conectado')
    .in('id', ids)
    .eq('company_id', companyId)
  if (wErr) throw wErr

  const waMap = (wa ?? []).reduce((m, i) => { m[i.id] = i; return m }, {})
  const instancias = (configs ?? []).map((c) => {
    const inst = waMap[c.instancia_id] ?? {}
    return {
      instancia_id: c.instancia_id,
      ordem: c.ordem,
      ativa_na_campanha: c.ativa,
      id: inst.id ?? c.instancia_id,
      nome: inst.nome ?? `#${c.instancia_id}`,
      status: inst.status ?? 'unknown',
      ativo: inst.ativo ?? false,
      display_phone: inst.display_phone ?? inst.telefone_conectado ?? null,
      conectada: (inst.status === 'connected' || inst.status === 'authenticated' || inst.status === 'standby')
        && inst.ativo === true,
    }
  })

  // Só trata como bloqueante se inativa. Status stale/unknown não impede o wizard
  // (parser UltraMSG aninhado já gerou falso "disconnected" no passado).
  const desconectadas = instancias
    .filter((i) => i.ativo === false)
    .map((i) => ({ id: i.id, nome: i.nome, status: i.status, ativo: i.ativo }))

  return { instancias, desconectadas }
}

async function marcarRevisaoLimites(campanhaId, companyId) {
  await supabase.from('disparo_campanhas')
    .update({ limites_revisao: true, atualizado_em: new Date().toISOString() })
    .eq('id', campanhaId).eq('company_id', companyId)
    .eq('limites_confirmados', true)
  await supabase.from('disparo_campanha_limites')
    .update({ revisao: true, confirmada: false, atualizado_em: new Date().toISOString() })
    .eq('campanha_id', campanhaId).eq('company_id', companyId)
    .eq('confirmada', true)
}

async function marcarRevisaoAposEdicao(campanhaId, companyId, campanha) {
  if (!campanha?.limites_confirmados) return
  await marcarRevisaoLimites(campanhaId, companyId)
  await supabase.from('disparo_campanhas')
    .update({
      limites_confirmados: false,
      limites_revisao: true,
      atualizado_em: new Date().toISOString(),
    })
    .eq('id', campanhaId).eq('company_id', companyId)
}

async function revalidarInstanciasConectadas(campanhaId, companyId) {
  const { data: configs, error } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .eq('ativa', true)
  if (error) throw error

  const ids = (configs ?? []).map((c) => c.instancia_id).filter(Boolean)
  if (!ids.length) {
    return { ok: false, desconectadas: [], mensagem: 'Nenhuma instância ativa na campanha.' }
  }

  const { data: instancias, error: iErr } = await supabase
    .from('whatsapp_instances')
    .select('id, nome, status, ativo')
    .in('id', ids)
    .eq('company_id', companyId)
  if (iErr) throw iErr

  const desconectadas = (instancias ?? [])
    .filter((i) => i.ativo === false)
    .map((i) => ({ id: i.id, nome: i.nome, status: i.status }))

  // Tenta corrigir status stale via UltraMSG (parser aninhado)
  try {
    const { getStatus } = require('../services/ultramsgIntegrationService')
    const ativas = (instancias ?? []).filter((i) => i.ativo !== false)
    await Promise.all(ativas.map(async (inst) => {
      if (['connected', 'authenticated', 'standby'].includes(String(inst.status || ''))) return
      try {
        const live = await getStatus(companyId, { whatsappInstanceId: inst.id })
        if (live?.connected === true) {
          inst.status = 'connected'
          supabase.from('whatsapp_instances')
            .update({ status: 'connected', status_at: new Date().toISOString() })
            .eq('id', inst.id)
            .eq('company_id', companyId)
            .then(() => {})
            .catch(() => {})
        }
      } catch (_) { /* ignore */ }
    }))
  } catch (_) { /* getStatus indisponível */ }

  // ok=true se todas ativas (status de conexão não bloqueia mais o wizard/revisão)
  return { ok: desconectadas.length === 0, desconectadas }
}

async function contarDestinatarios(campanhaId, companyId) {
  const { count, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id', { count: 'exact', head: true })
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
  if (error) throw error
  return count ?? 0
}

async function montarDestinatariosPorInstancia(campanhaId, companyId) {
  const { data: rows, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('instancia_id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
  if (error) throw error

  const contagem = (rows ?? []).reduce((m, r) => {
    if (!r.instancia_id) return m
    m.set(r.instancia_id, (m.get(r.instancia_id) ?? 0) + 1)
    return m
  }, new Map())

  const ids = [...contagem.keys()]
  let nomes = {}
  if (ids.length) {
    const { data: inst } = await supabase
      .from('whatsapp_instances')
      .select('id, nome')
      .in('id', ids)
      .eq('company_id', companyId)
    nomes = (inst ?? []).reduce((m, i) => { m[i.id] = i.nome; return m }, {})
  }

  return [...contagem.entries()].map(([instancia_id, quantidade]) => ({
    instancia_id,
    nome: nomes[instancia_id] ?? `#${instancia_id}`,
    quantidade,
  }))
}

async function executarSimulacao(campanhaId, companyId) {
  const [globalCfg, overrides, janelas, destinatariosPorInstancia] = await Promise.all([
    carregarLimitesGlobais(campanhaId, companyId),
    carregarOverridesInstancia(campanhaId, companyId),
    carregarTodasJanelas(campanhaId, companyId),
    montarDestinatariosPorInstancia(campanhaId, companyId),
  ])

  const { globais, porInstancia } = separarJanelas(janelas)
  const overridesByInst = (overrides ?? []).reduce((m, o) => {
    m[o.instancia_id] = o
    return m
  }, {})

  return simularDuracao({
    destinatariosPorInstancia,
    globalCfg,
    overridesByInst,
    janelasGlobais: globais,
    janelasByInst: porInstancia,
  })
}

async function executarValidacaoConfigLimites(campanhaId, companyId, campanha, bodyParcial = null) {
  const erros = []
  const avisos = []
  const checks = {}

  const totalDest = await contarDestinatarios(campanhaId, companyId)
  checks.destinatarios = totalDest > 0
  if (!checks.destinatarios) erros.push('Adicione ao menos um destinatário à campanha.')

  checks.distribuicao_confirmada = !!campanha.distribuicao_confirmada
  if (!checks.distribuicao_confirmada) erros.push('Confirme a distribuição por instância (Etapa 3).')
  checks.distribuicao_revisao = !campanha.distribuicao_revisao
  if (campanha.distribuicao_revisao) erros.push('A distribuição foi alterada e precisa ser revisada.')

  checks.variacao_confirmada = !!campanha.variacao_confirmada
  if (!checks.variacao_confirmada) erros.push('Confirme as variações de mensagem (Etapa 4).')
  checks.variacao_revisao = !campanha.variacao_revisao
  if (campanha.variacao_revisao) erros.push('As variações foram alteradas e precisam ser revisadas.')

  const instCheck = await revalidarInstanciasConectadas(campanhaId, companyId)
  checks.instancias_conectadas = instCheck.ok
  if (!instCheck.ok) {
    if (instCheck.mensagem) {
      erros.push(instCheck.mensagem)
    }
    for (const d of instCheck.desconectadas) {
      erros.push(`Instância "${d.nome}" desconectada (status: ${d.status}).`)
    }
  }

  const limitesDb = await carregarLimitesGlobais(campanhaId, companyId)
  const merged = bodyParcial ? { ...limitesDb, ...bodyParcial } : limitesDb
  const valLimites = validarLimitesGlobais(merged)
  checks.limites_validos = valLimites.ok
  erros.push(...valLimites.erros)
  avisos.push(...valLimites.avisos)

  const janelasDb = await carregarTodasJanelas(campanhaId, companyId)
  const { globais } = separarJanelas(janelasDb)
  const valJanelas = validarJanelas(globais.length ? globais : janelasDb.filter((j) => j.instancia_id == null))
  checks.janelas_validas = valJanelas.ok
  if (!valJanelas.ok) erros.push(...valJanelas.erros)
  avisos.push(...valJanelas.avisos)

  const fuso = merged.fuso_horario || FUSO_PADRAO
  checks.agendamento_valido = true
  checks.agendamento_na_janela = true

  if (merged.inicio_modo === 'agendado') {
    if (!merged.agendado_para) {
      checks.agendamento_valido = false
      erros.push('Agendamento exige data e hora.')
    } else {
      const dt = DateTime.fromISO(String(merged.agendado_para), { zone: 'utc' }).setZone(fuso)
      const janelasAg = globais.length ? globais : valJanelas.cleaned
      if (janelasAg.length && !estaNaJanela(dt, janelasAg)) {
        checks.agendamento_na_janela = false
        const prox = proximoHorarioPermitido(dt, janelasAg)
        const proxIso = prox ? prox.setZone(fuso).toISO() : null
        avisos.push(
          proxIso
            ? `Agendamento fora da janela permitida. Próximo horário: ${prox.toFormat('dd/LL/yyyy HH:mm')} (${fuso}).`
            : 'Agendamento fora da janela e não há horário futuro disponível.',
        )
        checks.proximo_horario_permitido = proxIso
      }
    }
  }

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    checks,
    limites: valLimites.cleaned ?? merged,
  }
}

async function executarLocalizarConflitos(campanhaId, companyId) {
  const { data: campInst, error: ciErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (ciErr) throw ciErr

  const instanciaIds = [...new Set((campInst ?? []).map((r) => r.instancia_id).filter(Boolean))]
  if (!instanciaIds.length) {
    return { conflitos: [], conflito_impeditivo: false, avisos: [] }
  }

  const { data: outrasInst, error: oiErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id, campanha_id')
    .eq('company_id', companyId)
    .in('instancia_id', instanciaIds)
    .neq('campanha_id', campanhaId)
  if (oiErr) throw oiErr

  const outrasCampanhaIds = [...new Set((outrasInst ?? []).map((r) => r.campanha_id))]
  if (!outrasCampanhaIds.length) {
    return { conflitos: [], conflito_impeditivo: false, avisos: [] }
  }

  const [{ data: campanhas }, { data: limites }] = await Promise.all([
    supabase.from('disparo_campanhas')
      .select('id, nome, status, limites_confirmados')
      .in('id', outrasCampanhaIds)
      .eq('company_id', companyId),
    supabase.from('disparo_campanha_limites')
      .select('campanha_id, inicio_modo, agendado_para')
      .in('campanha_id', outrasCampanhaIds)
      .eq('company_id', companyId),
  ])

  const campMap = (campanhas ?? []).reduce((m, c) => { m[c.id] = c; return m }, {})
  const limMap = (limites ?? []).reduce((m, l) => { m[l.campanha_id] = l; return m }, {})

  const conflitos = []
  const avisos = []

  for (const row of outrasInst ?? []) {
    const camp = campMap[row.campanha_id]
    if (!camp) continue

    const lim = limMap[row.campanha_id] ?? {}
    const status = camp.status
    const limitesConfirmados = camp.limites_confirmados === true
    const inicioModo = lim.inicio_modo ?? 'imediato'

    const emExecucao = status === 'em_execucao'
    const agendada = status === 'agendada'
    const confirmadaAgendada = limitesConfirmados && inicioModo === 'agendado' && !emExecucao && !agendada

    if (!emExecucao && !agendada && !confirmadaAgendada) continue

    let tipo = 'confirmada'
    if (emExecucao) tipo = 'em_execucao'
    else if (agendada) tipo = 'agendada'

    conflitos.push({
      instancia_id: row.instancia_id,
      campanha_id: camp.id,
      campanha_nome: camp.nome,
      status: camp.status,
      agendado_para: lim.agendado_para ?? null,
      inicio_modo: inicioModo,
      tipo,
    })
  }

  const conflito_impeditivo = conflitos.some((c) => c.tipo === 'em_execucao' || c.tipo === 'agendada')
  if (conflitos.some((c) => c.tipo === 'confirmada')) {
    avisos.push('Existem outras campanhas confirmadas com agendamento usando a mesma instância.')
  }

  return { conflitos, conflito_impeditivo, avisos }
}

// ─── 1. Obter configuração de limites ─────────────────────────────────────────

exports.obterConfigLimites = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const [limites, overrides, janelas, instData] = await Promise.all([
      carregarLimitesGlobais(campanhaId, companyId),
      carregarOverridesInstancia(campanhaId, companyId),
      carregarTodasJanelas(campanhaId, companyId),
      carregarInstanciasCampanha(campanhaId, companyId),
    ])

    const { globais, porInstancia } = separarJanelas(janelas)

    res.json({
      limites,
      instancia_limites: overrides,
      janelas: globais,
      janelas_por_instancia: porInstancia,
      instancias: instData.instancias,
      instancias_desconectadas: instData.desconectadas,
      limites_confirmados: campanha.limites_confirmados,
      limites_revisao: campanha.limites_revisao,
      distribuicao_confirmada: campanha.distribuicao_confirmada,
      variacao_confirmada: campanha.variacao_confirmada,
      perfis: PERFIS,
      fuso_padrao: FUSO_PADRAO,
      regra_retentativa: REGRA_RETENTATIVA,
    })
  } catch (err) {
    console.error('[disparo:limites] obterConfigLimites', err)
    res.status(500).json({ error: 'Erro ao carregar configuração de limites.' })
  }
}

// ─── 2. Salvar limites globais ────────────────────────────────────────────────

exports.salvarLimitesGlobais = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar limites nesta fase da campanha.' })
    }

    const existente = await carregarLimitesGlobais(campanhaId, companyId)
    const merged = { ...existente, ...req.body }
    const { ok, erros, avisos, cleaned } = validarLimitesGlobais(merged)
    if (!ok) return res.status(422).json({ error: erros[0], erros, avisos })

    const agora = new Date().toISOString()
    const row = {
      company_id: companyId,
      campanha_id: campanhaId,
      perfil: cleaned.perfil,
      limite_total: cleaned.limite_total,
      limite_por_hora: cleaned.limite_por_hora,
      limite_por_dia: cleaned.limite_por_dia,
      intervalo_min_sec: cleaned.intervalo_min_sec,
      intervalo_max_sec: cleaned.intervalo_max_sec,
      lote_tamanho: cleaned.lote_tamanho,
      pausa_lote_min_sec: cleaned.pausa_lote_min_sec,
      pausa_lote_max_sec: cleaned.pausa_lote_max_sec,
      fuso_horario: cleaned.fuso_horario,
      inicio_modo: cleaned.inicio_modo,
      agendado_para: cleaned.agendado_para,
      data_limite: cleaned.data_limite,
      pausa_auto_desconexao: cleaned.pausa_auto_desconexao,
      pausa_auto_erros_consecutivos: cleaned.pausa_auto_erros_consecutivos,
      pausa_auto_taxa_falha_pct: cleaned.pausa_auto_taxa_falha_pct,
      configurado_por: req.user.id ?? null,
      atualizado_em: agora,
    }

    const { data, error } = await supabase
      .from('disparo_campanha_limites')
      .upsert(row, { onConflict: 'campanha_id' })
      .select(LIMITES_SELECT)
      .single()
    if (error) throw error

    if (campanha.limites_confirmados) {
      await marcarRevisaoAposEdicao(campanhaId, companyId, campanha)
    }

    res.json({ limites: data, avisos })
  } catch (err) {
    console.error('[disparo:limites] salvarLimitesGlobais', err)
    res.status(500).json({ error: 'Erro ao salvar limites globais.' })
  }
}

// ─── 3. Salvar limites por instância ──────────────────────────────────────────

exports.salvarLimitesInstancias = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar limites nesta fase.' })
    }

    const instancias = Array.isArray(req.body.instancias) ? req.body.instancias : []
    if (!instancias.length) return res.status(400).json({ error: 'Nenhuma instância informada.' })

    const globalCfg = await carregarLimitesGlobais(campanhaId, companyId)

    const { data: campInst } = await supabase
      .from('disparo_campanha_instancias')
      .select('instancia_id')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
    const validasSet = new Set((campInst ?? []).map((r) => r.instancia_id))

    const erros = []
    const avisos = []
    const salvos = []
    const agora = new Date().toISOString()

    for (const item of instancias) {
      const instanciaId = positiveInt(item.instancia_id)
      if (!instanciaId) {
        erros.push('instancia_id inválido em um dos itens.')
        continue
      }
      if (!validasSet.has(instanciaId)) {
        erros.push(`Instância ${instanciaId} não pertence a esta campanha.`)
        continue
      }

      const { ok, erros: eInst, avisos: aInst, cleaned } = validarLimitesInstancia(item, globalCfg)
      if (!ok) {
        erros.push(...eInst.map((e) => `[instância ${instanciaId}] ${e}`))
        continue
      }
      avisos.push(...aInst)

      const row = {
        company_id: companyId,
        campanha_id: campanhaId,
        instancia_id: instanciaId,
        herdar_global: cleaned.herdar_global,
        janelas_proprias: cleaned.janelas_proprias,
        limite_por_hora: cleaned.limite_por_hora,
        limite_por_dia: cleaned.limite_por_dia,
        intervalo_min_sec: cleaned.intervalo_min_sec,
        intervalo_max_sec: cleaned.intervalo_max_sec,
        lote_tamanho: cleaned.lote_tamanho,
        pausa_lote_min_sec: cleaned.pausa_lote_min_sec,
        pausa_lote_max_sec: cleaned.pausa_lote_max_sec,
        atualizado_em: agora,
      }

      const { data, error } = await supabase
        .from('disparo_campanha_instancia_limites')
        .upsert(row, { onConflict: 'campanha_id,instancia_id' })
        .select(INST_LIMITES_SELECT)
        .single()
      if (error) throw error
      salvos.push(data)
    }

    if (erros.length) return res.status(422).json({ error: erros[0], erros, avisos })

    if (campanha.limites_confirmados) {
      await marcarRevisaoAposEdicao(campanhaId, companyId, campanha)
    }

    res.json({ instancia_limites: salvos, avisos })
  } catch (err) {
    console.error('[disparo:limites] salvarLimitesInstancias', err)
    res.status(500).json({ error: 'Erro ao salvar limites por instância.' })
  }
}

// ─── 4. Salvar janelas ────────────────────────────────────────────────────────

exports.salvarJanelas = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar janelas nesta fase.' })
    }

    const janelasBody = Array.isArray(req.body.janelas) ? req.body.janelas : []
    const instanciaIdRaw = req.body.instancia_id
    const instanciaId = instanciaIdRaw == null || instanciaIdRaw === ''
      ? null
      : positiveInt(instanciaIdRaw)

    if (instanciaId) {
      const { data: check } = await supabase
        .from('disparo_campanha_instancias')
        .select('instancia_id')
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId)
        .eq('instancia_id', instanciaId)
        .maybeSingle()
      if (!check) return res.status(400).json({ error: 'Instância não pertence a esta campanha.' })
    }

    const janelasComInst = janelasBody.map((j) => ({
      ...j,
      instancia_id: instanciaId,
    }))

    const { ok, erros, avisos, cleaned } = validarJanelas(janelasComInst)
    if (!ok) return res.status(422).json({ error: erros[0], erros, avisos })

    let deleteQuery = supabase
      .from('disparo_campanha_janelas')
      .delete()
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)

    if (instanciaId == null) {
      deleteQuery = deleteQuery.is('instancia_id', null)
    } else {
      deleteQuery = deleteQuery.eq('instancia_id', instanciaId)
    }
    const { error: delErr } = await deleteQuery
    if (delErr) throw delErr

    if (cleaned.length) {
      const rows = cleaned.map((j) => ({
        company_id: companyId,
        campanha_id: campanhaId,
        instancia_id: instanciaId,
        dia_semana: j.dia_semana,
        hora_inicio: j.hora_inicio,
        hora_fim: j.hora_fim,
        ativo: j.ativo,
      }))
      const { error: insErr } = await supabase.from('disparo_campanha_janelas').insert(rows)
      if (insErr) throw insErr
    }

    if (instanciaId != null) {
      await supabase.from('disparo_campanha_instancia_limites')
        .upsert({
          company_id: companyId,
          campanha_id: campanhaId,
          instancia_id: instanciaId,
          janelas_proprias: true,
          herdar_global: false,
          atualizado_em: new Date().toISOString(),
        }, { onConflict: 'campanha_id,instancia_id' })
    }

    if (campanha.limites_confirmados) {
      await marcarRevisaoAposEdicao(campanhaId, companyId, campanha)
    }

    const { data: salvas } = await supabase
      .from('disparo_campanha_janelas')
      .select(JANELAS_SELECT)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .is('instancia_id', instanciaId == null ? null : instanciaId)
      .order('dia_semana')
      .order('hora_inicio')

    res.json({ janelas: salvas ?? [], avisos, instancia_id: instanciaId })
  } catch (err) {
    console.error('[disparo:limites] salvarJanelas', err)
    res.status(500).json({ error: 'Erro ao salvar janelas.' })
  }
}

// ─── 5. Salvar agendamento ────────────────────────────────────────────────────

exports.salvarAgendamento = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível alterar agendamento nesta fase.' })
    }

    const existente = await carregarLimitesGlobais(campanhaId, companyId)
    const merged = {
      ...existente,
      inicio_modo: req.body.inicio_modo ?? existente.inicio_modo,
      agendado_para: req.body.agendado_para !== undefined ? req.body.agendado_para : existente.agendado_para,
      data_limite: req.body.data_limite !== undefined ? req.body.data_limite : existente.data_limite,
    }

    const { ok, erros, avisos, cleaned } = validarLimitesGlobais(merged)
    if (!ok) return res.status(422).json({ error: erros[0], erros, avisos })

    const avisosResp = [...avisos]
    let proximo_horario_permitido = null
    let agendadoFinal = cleaned.agendado_para

    if (cleaned.inicio_modo === 'agendado' && cleaned.agendado_para) {
      const janelasDb = await carregarTodasJanelas(campanhaId, companyId)
      const { globais } = separarJanelas(janelasDb)
      const fuso = cleaned.fuso_horario || FUSO_PADRAO
      const dt = DateTime.fromISO(String(cleaned.agendado_para), { zone: 'utc' }).setZone(fuso)

      if (globais.length && !estaNaJanela(dt, globais)) {
        const prox = proximoHorarioPermitido(dt, globais)
        proximo_horario_permitido = prox ? prox.setZone(fuso).toISO() : null
        avisosResp.push(
          proximo_horario_permitido
            ? 'Agendamento fora da janela permitida.'
            : 'Agendamento fora da janela e sem horário futuro disponível.',
        )

        if (req.body.ajustar_automaticamente === true && prox) {
          agendadoFinal = prox.toUTC().toISO()
          cleaned.agendado_para = agendadoFinal
        }
      }
    }

    const agora = new Date().toISOString()
    const defaults = buildDefaultsLimites(campanhaId, companyId)
    const base = existente.persistido ? existente : defaults

    const row = {
      company_id: companyId,
      campanha_id: campanhaId,
      perfil: base.perfil,
      limite_total: base.limite_total,
      limite_por_hora: base.limite_por_hora,
      limite_por_dia: base.limite_por_dia,
      intervalo_min_sec: base.intervalo_min_sec,
      intervalo_max_sec: base.intervalo_max_sec,
      lote_tamanho: base.lote_tamanho,
      pausa_lote_min_sec: base.pausa_lote_min_sec,
      pausa_lote_max_sec: base.pausa_lote_max_sec,
      fuso_horario: base.fuso_horario,
      pausa_auto_desconexao: base.pausa_auto_desconexao,
      pausa_auto_erros_consecutivos: base.pausa_auto_erros_consecutivos,
      pausa_auto_taxa_falha_pct: base.pausa_auto_taxa_falha_pct,
      inicio_modo: cleaned.inicio_modo,
      agendado_para: cleaned.inicio_modo === 'imediato' ? null : agendadoFinal,
      data_limite: cleaned.data_limite,
      configurado_por: req.user.id ?? null,
      atualizado_em: agora,
    }

    const { data, error } = await supabase
      .from('disparo_campanha_limites')
      .upsert(row, { onConflict: 'campanha_id' })
      .select(LIMITES_SELECT)
      .single()
    if (error) throw error

    if (campanha.limites_confirmados) {
      await marcarRevisaoAposEdicao(campanhaId, companyId, campanha)
    }

    res.json({
      limites: data,
      avisos: avisosResp,
      proximo_horario_permitido,
      ajustado_automaticamente: req.body.ajustar_automaticamente === true && !!proximo_horario_permitido,
    })
  } catch (err) {
    console.error('[disparo:limites] salvarAgendamento', err)
    res.status(500).json({ error: 'Erro ao salvar agendamento.' })
  }
}

// ─── 6. Cancelar agendamento ──────────────────────────────────────────────────

exports.cancelarAgendamento = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível cancelar agendamento nesta fase.' })
    }

    const existente = await carregarLimitesGlobais(campanhaId, companyId)
    if (!existente.persistido) {
      return res.json({
        limites: { ...existente, inicio_modo: 'imediato', agendado_para: null },
        ok: true,
      })
    }

    const { data, error } = await supabase
      .from('disparo_campanha_limites')
      .update({
        inicio_modo: 'imediato',
        agendado_para: null,
        configurado_por: req.user.id ?? null,
        atualizado_em: new Date().toISOString(),
      })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .select(LIMITES_SELECT)
      .single()
    if (error) throw error

    if (campanha.limites_confirmados) {
      await marcarRevisaoAposEdicao(campanhaId, companyId, campanha)
    }

    res.json({ limites: data, ok: true })
  } catch (err) {
    console.error('[disparo:limites] cancelarAgendamento', err)
    res.status(500).json({ error: 'Erro ao cancelar agendamento.' })
  }
}

// ─── 7. Validar configuração ────────────────────────────────────────────────

exports.validarConfigLimites = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const bodyParcial = req.body && Object.keys(req.body).length ? req.body : null
    const resultado = await executarValidacaoConfigLimites(campanhaId, companyId, campanha, bodyParcial)

    res.json(resultado)
  } catch (err) {
    console.error('[disparo:limites] validarConfigLimites', err)
    res.status(500).json({ error: 'Erro ao validar configuração.' })
  }
}

// ─── 8. Localizar conflitos ───────────────────────────────────────────────────

exports.localizarConflitos = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const resultado = await executarLocalizarConflitos(campanhaId, companyId)
    res.json(resultado)
  } catch (err) {
    console.error('[disparo:limites] localizarConflitos', err)
    res.status(500).json({ error: 'Erro ao localizar conflitos.' })
  }
}

// ─── 9. Simular duração ───────────────────────────────────────────────────────

exports.simular = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const resultado = await executarSimulacao(campanhaId, companyId)
    res.json(resultado)
  } catch (err) {
    console.error('[disparo:limites] simular', err)
    res.status(500).json({ error: 'Erro ao simular duração.' })
  }
}

// ─── 10. Confirmar limites ────────────────────────────────────────────────────

exports.confirmarLimites = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return
    if (!statusPermiteEdicao(campanha.status)) {
      return res.status(422).json({ error: 'Não é possível confirmar limites nesta fase.' })
    }

    if (campanha.limites_confirmados && !campanha.limites_revisao) {
      const limites = await carregarLimitesGlobais(campanhaId, companyId)
      return res.json({
        ok: true,
        idempotente: true,
        limites_confirmados: true,
        limites,
      })
    }

    const validacao = await executarValidacaoConfigLimites(campanhaId, companyId, campanha)
    const conflitos = await executarLocalizarConflitos(campanhaId, companyId)
    const simulacao = await executarSimulacao(campanhaId, companyId)

    const erros = [
      ...validacao.erros,
      ...(conflitos.conflito_impeditivo
        ? ['Existem conflitos impeditivos com outras campanhas nas mesmas instâncias.']
        : []),
      ...simulacao.erros,
    ]

    if (erros.length || conflitos.conflito_impeditivo) {
      return res.status(422).json({
        error: erros[0] || 'Não foi possível confirmar os limites.',
        erros,
        avisos: [...validacao.avisos, ...conflitos.avisos, ...simulacao.avisos],
        checks: validacao.checks,
        conflitos: conflitos.conflitos,
        conflito_impeditivo: conflitos.conflito_impeditivo,
        simulacao,
      })
    }

    const agora = new Date().toISOString()
    const limitesAtual = await carregarLimitesGlobais(campanhaId, companyId)

    if (!limitesAtual.persistido) {
      const defaults = buildDefaultsLimites(campanhaId, companyId)
      const valDefaults = validarLimitesGlobais(defaults)
      if (!valDefaults.ok) {
        return res.status(422).json({
          error: valDefaults.erros[0] || 'Configure os limites antes de confirmar.',
          erros: valDefaults.erros,
        })
      }
      const cleaned = valDefaults.cleaned
      await supabase.from('disparo_campanha_limites').insert({
        company_id: companyId,
        campanha_id: campanhaId,
        perfil: cleaned.perfil,
        limite_total: cleaned.limite_total,
        limite_por_hora: cleaned.limite_por_hora,
        limite_por_dia: cleaned.limite_por_dia,
        intervalo_min_sec: cleaned.intervalo_min_sec,
        intervalo_max_sec: cleaned.intervalo_max_sec,
        lote_tamanho: cleaned.lote_tamanho,
        pausa_lote_min_sec: cleaned.pausa_lote_min_sec,
        pausa_lote_max_sec: cleaned.pausa_lote_max_sec,
        fuso_horario: cleaned.fuso_horario,
        inicio_modo: cleaned.inicio_modo,
        agendado_para: cleaned.agendado_para,
        data_limite: cleaned.data_limite,
        pausa_auto_desconexao: cleaned.pausa_auto_desconexao,
        pausa_auto_erros_consecutivos: cleaned.pausa_auto_erros_consecutivos,
        pausa_auto_taxa_falha_pct: cleaned.pausa_auto_taxa_falha_pct,
        confirmada: true,
        revisao: false,
        configurado_por: req.user.id ?? null,
        criado_em: agora,
        atualizado_em: agora,
      })
    } else {
      await supabase.from('disparo_campanha_limites')
        .update({
          confirmada: true,
          revisao: false,
          configurado_por: req.user.id ?? null,
          atualizado_em: agora,
        })
        .eq('campanha_id', campanhaId)
        .eq('company_id', companyId)
    }

    await supabase.from('disparo_campanhas')
      .update({
        limites_confirmados: true,
        limites_revisao: false,
        status: 'configurando',
        atualizado_em: agora,
      })
      .eq('id', campanhaId)
      .eq('company_id', companyId)

    const limites = await carregarLimitesGlobais(campanhaId, companyId)

    res.json({
      ok: true,
      limites_confirmados: true,
      limites,
      avisos: [...validacao.avisos, ...conflitos.avisos, ...simulacao.avisos],
      simulacao: simulacao.resumo,
    })
  } catch (err) {
    console.error('[disparo:limites] confirmarLimites', err)
    res.status(500).json({ error: 'Erro ao confirmar limites.' })
  }
}

// ─── 11. Necessidade de revisão ───────────────────────────────────────────────

exports.necessidadeRevisao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const motivos = []
    if (campanha.limites_revisao) motivos.push('Os limites foram alterados após confirmação.')
    if (campanha.distribuicao_revisao) motivos.push('A distribuição por instância foi alterada.')
    if (campanha.variacao_revisao) motivos.push('As variações de mensagem foram alteradas.')

    const instCheck = await revalidarInstanciasConectadas(campanhaId, companyId)
    if (!instCheck.ok) {
      for (const d of instCheck.desconectadas) {
        motivos.push(`Instância "${d.nome}" desconectada (status: ${d.status}).`)
      }
      if (instCheck.mensagem && !instCheck.desconectadas.length) {
        motivos.push(instCheck.mensagem)
      }
    }

    if (campanha.limites_confirmados && !campanha.distribuicao_confirmada) {
      motivos.push('Distribuição por instância não confirmada.')
    }
    if (campanha.limites_confirmados && !campanha.variacao_confirmada) {
      motivos.push('Variações de mensagem não confirmadas.')
    }

    const limitesDb = await carregarLimitesGlobais(campanhaId, companyId)
    if (limitesDb.revisao) motivos.push('Registro de limites marcado para revisão.')

    res.json({
      limites_revisao: campanha.limites_revisao || limitesDb.revisao || motivos.length > 0,
      limites_confirmados: campanha.limites_confirmados,
      motivos: [...new Set(motivos)],
    })
  } catch (err) {
    console.error('[disparo:limites] necessidadeRevisao', err)
    res.status(500).json({ error: 'Erro ao verificar necessidade de revisão.' })
  }
}

// ─── Exports para testes ──────────────────────────────────────────────────────

exports._marcarRevisaoLimites = marcarRevisaoLimites
exports.revalidarInstanciasConectadas = revalidarInstanciasConectadas
