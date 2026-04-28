const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')

const OPEN_STATUSES = ['aberta', 'em_atendimento', 'aguardando_cliente']
const DEFAULT_SLA_MINUTES = 30

function toSafeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfPeriod(periodo) {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (periodo === '7dias') {
    start.setDate(start.getDate() - 6)
    return start
  }
  if (periodo === 'mes') {
    start.setDate(1)
    return start
  }
  return start
}

function buildSlaThresholds(slaMinutes, usingDefault) {
  const criticalAt = Math.max(1, Number(slaMinutes) || DEFAULT_SLA_MINUTES)
  if (usingDefault) {
    return {
      criticalAt,
      attentionAt: 10,
    }
  }
  return {
    criticalAt,
    attentionAt: Math.max(1, Math.floor(criticalAt * 0.5)),
  }
}

function getNivel(minutosAguardando, thresholds) {
  if (minutosAguardando >= thresholds.criticalAt) return 'critico'
  if (minutosAguardando >= thresholds.attentionAt) return 'atencao'
  return 'normal'
}

function getStatusRank(nivel) {
  if (nivel === 'critico') return 0
  if (nivel === 'atencao') return 1
  return 2
}

function minutesSince(isoDate) {
  if (!isoDate) return 0
  const diff = Date.now() - new Date(isoDate).getTime()
  return Math.max(0, Math.floor(diff / 60000))
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '')
}

async function getSlaConfig(companyId) {
  const { data, error } = await supabase
    .from('empresas')
    .select('sla_minutos_sem_resposta')
    .eq('id', companyId)
    .single()

  if (error) throw error

  const raw = toSafeInt(data?.sla_minutos_sem_resposta)
  const usingDefault = !Number.isFinite(raw) || raw == null || raw <= 0
  const slaMinutes = usingDefault ? DEFAULT_SLA_MINUTES : Math.max(1, Math.min(1440, raw))
  const thresholds = buildSlaThresholds(slaMinutes, usingDefault)

  return {
    slaMinutes,
    thresholds,
  }
}

async function listDepartamentosMap(companyId, departamentoIds) {
  const ids = (departamentoIds || []).filter((id) => Number.isFinite(Number(id)))
  if (ids.length === 0) return {}
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw error
  const depMap = {}
  ;(data || []).forEach((dep) => {
    depMap[String(dep.id)] = dep.nome || null
  })
  return depMap
}

async function listOpenConversations(companyId) {
  const { data, error } = await supabase
    .from('conversas')
    .select(`
      id,
      company_id,
      telefone,
      status_atendimento,
      departamento_id,
      atendente_id,
      criado_em,
      nome_contato_cache,
      foto_perfil_contato_cache,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil ),
      usuarios!conversas_atendente_fk ( id, nome, perfil )
    `)
    .eq('company_id', companyId)
    .in('status_atendimento', OPEN_STATUSES)
    .order('criado_em', { ascending: false })

  if (error) throw error
  return data || []
}

async function listLastMessagesByConversation(companyId, conversationIds) {
  if (!conversationIds.length) return new Map()
  const { data, error } = await supabase
    .from('mensagens')
    .select('conversa_id, direcao, texto, criado_em')
    .eq('company_id', companyId)
    .in('conversa_id', conversationIds)
    .in('direcao', ['in', 'out'])
    .order('criado_em', { ascending: false })

  if (error) throw error

  const map = new Map()
  for (const msg of data || []) {
    if (!map.has(msg.conversa_id)) {
      map.set(msg.conversa_id, msg)
    }
  }
  return map
}

function buildPendingItem(conversa, lastMessage, depMap, thresholds) {
  if (!lastMessage || lastMessage.direcao !== 'in') return null

  const minutosAguardando = minutesSince(lastMessage.criado_em)
  const nivel = getNivel(minutosAguardando, thresholds)
  const departamentoNome = conversa.departamento_id != null
    ? depMap[String(conversa.departamento_id)] || 'Sem departamento'
    : 'Sem departamento'
  const clienteObj = conversa.clientes || null
  const clienteNome = getDisplayName(clienteObj) || conversa.nome_contato_cache || conversa.telefone || 'Cliente'

  return {
    conversa_id: conversa.id,
    cliente_nome: clienteNome,
    telefone: conversa.telefone || clienteObj?.telefone || null,
    foto_perfil: clienteObj?.foto_perfil || conversa.foto_perfil_contato_cache || null,
    departamento_id: conversa.departamento_id || null,
    departamento_nome: departamentoNome,
    atendente_id: conversa.atendente_id || null,
    atendente_nome: conversa.usuarios?.nome || null,
    ultima_mensagem_texto: lastMessage.texto || '',
    ultima_mensagem_em: lastMessage.criado_em || null,
    ultima_mensagem_direcao: lastMessage.direcao,
    minutos_aguardando: minutosAguardando,
    nivel,
    status_atendimento: conversa.status_atendimento,
    aguardando_funcionario: true,
    atrasado: minutosAguardando >= thresholds.criticalAt,
    pode_abrir_conversa: true,
  }
}

async function buildConversationInsights(companyId) {
  const [slaConfig, conversations] = await Promise.all([
    getSlaConfig(companyId),
    listOpenConversations(companyId),
  ])

  const conversationIds = conversations.map((c) => c.id)
  const [lastMessagesMap, depMap] = await Promise.all([
    listLastMessagesByConversation(companyId, conversationIds),
    listDepartamentosMap(companyId, [...new Set(conversations.map((c) => c.departamento_id).filter((x) => x != null))]),
  ])

  const pending = []
  const aguardandoCliente = []

  for (const conversa of conversations) {
    const lastMessage = lastMessagesMap.get(conversa.id)
    if (!lastMessage) continue
    if (lastMessage.direcao === 'out') {
      aguardandoCliente.push({
        conversa_id: conversa.id,
        status_atendimento: conversa.status_atendimento,
      })
      continue
    }
    const pendingItem = buildPendingItem(conversa, lastMessage, depMap, slaConfig.thresholds)
    if (pendingItem) pending.push(pendingItem)
  }

  return {
    slaMinutes: slaConfig.slaMinutes,
    thresholds: slaConfig.thresholds,
    conversations,
    pending,
    aguardandoCliente,
  }
}

async function calculateAvgResponseMinutes(companyId, conversationIds, fromDate) {
  if (!conversationIds?.length) return null

  let query = supabase
    .from('mensagens')
    .select('conversa_id, criado_em, direcao')
    .eq('company_id', companyId)
    .in('conversa_id', conversationIds)
    .in('direcao', ['in', 'out'])
    .order('criado_em', { ascending: true })

  if (fromDate) {
    query = query.gte('criado_em', fromDate.toISOString())
  }

  const { data, error } = await query
  if (error) throw error

  const byConversation = new Map()
  for (const m of data || []) {
    if (!byConversation.has(m.conversa_id)) byConversation.set(m.conversa_id, [])
    byConversation.get(m.conversa_id).push(m)
  }

  let totalPairs = 0
  let totalMinutes = 0

  for (const messages of byConversation.values()) {
    let pendingIn = null
    for (const m of messages) {
      if (m.direcao === 'in' && pendingIn == null) {
        pendingIn = m
        continue
      }
      if (m.direcao === 'out' && pendingIn) {
        const diff = (new Date(m.criado_em).getTime() - new Date(pendingIn.criado_em).getTime()) / 60000
        if (diff >= 0) {
          totalMinutes += diff
          totalPairs += 1
        }
        pendingIn = null
      }
    }
  }

  if (totalPairs === 0) return null
  return Number((totalMinutes / totalPairs).toFixed(2))
}

async function listAtendimentosToday(companyId) {
  const todayIso = startOfToday().toISOString()
  const { data, error } = await supabase
    .from('atendimentos')
    .select('id, conversa_id, acao, criado_em, de_usuario_id, para_usuario_id')
    .eq('company_id', companyId)
    .gte('criado_em', todayIso)
    .order('criado_em', { ascending: false })
  if (error) throw error
  return data || []
}

async function listUsuariosCompany(companyId) {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, perfil')
    .eq('company_id', companyId)
    .order('nome', { ascending: true })
  if (error) throw error
  return data || []
}

function filterPendingItems(items, filters = {}) {
  let result = Array.isArray(items) ? [...items] : []

  if (filters.atendenteId != null) {
    result = result.filter((item) => Number(item.atendente_id) === Number(filters.atendenteId))
  }
  if (filters.departamentoId != null) {
    result = result.filter((item) => Number(item.departamento_id) === Number(filters.departamentoId))
  }
  if (filters.nivel) {
    result = result.filter((item) => item.nivel === filters.nivel)
  }
  if (filters.somenteAtrasados === true) {
    result = result.filter((item) => item.atrasado === true)
  }
  if (filters.busca) {
    const needle = String(filters.busca).trim().toLowerCase()
    const needlePhone = normalizePhone(filters.busca)
    result = result.filter((item) => {
      const nome = String(item.cliente_nome || '').toLowerCase()
      const tel = normalizePhone(item.telefone)
      if (needle && nome.includes(needle)) return true
      if (needlePhone && tel.includes(needlePhone)) return true
      return false
    })
  }
  if (filters.periodo) {
    const start = startOfPeriod(filters.periodo)
    result = result.filter((item) => {
      if (!item.ultima_mensagem_em) return false
      return new Date(item.ultima_mensagem_em) >= start
    })
  }

  result.sort((a, b) => {
    const rankDiff = getStatusRank(a.nivel) - getStatusRank(b.nivel)
    if (rankDiff !== 0) return rankDiff
    return b.minutos_aguardando - a.minutos_aguardando
  })

  return result
}

async function getResumo(companyId) {
  const insights = await buildConversationInsights(companyId)
  const [usuarios, atendimentosHoje, tempoMedioGlobal] = await Promise.all([
    listUsuariosCompany(companyId),
    listAtendimentosToday(companyId),
    calculateAvgResponseMinutes(companyId, insights.conversations.map((c) => c.id), startOfToday()),
  ])

  const funcionarios = usuarios.map((u) => {
    const assignedOpen = insights.conversations.filter((c) => Number(c.atendente_id) === Number(u.id))
    const assignedPending = insights.pending.filter((p) => Number(p.atendente_id) === Number(u.id))
    const atrasados = assignedPending.filter((p) => p.atrasado)
    const assumidos = atendimentosHoje.filter((a) => a.acao === 'assumiu' && (Number(a.para_usuario_id) === Number(u.id) || Number(a.de_usuario_id) === Number(u.id))).length
    const maiorTempo = assignedPending.length > 0 ? Math.max(...assignedPending.map((p) => p.minutos_aguardando)) : 0
    const nivel = assignedPending.some((p) => p.nivel === 'critico')
      ? 'critico'
      : assignedPending.some((p) => p.nivel === 'atencao')
        ? 'atencao'
        : 'normal'

    return {
      usuario_id: u.id,
      nome: u.nome || 'Sem nome',
      perfil: u.perfil || null,
      atendimentos_assumidos_hoje: assumidos,
      atendimentos_em_aberto: assignedOpen.length,
      clientes_sem_resposta: assignedPending.length,
      clientes_atrasados: atrasados.length,
      tempo_medio_resposta_minutos: null,
      maior_tempo_sem_resposta_minutos: maiorTempo,
      nivel,
    }
  })

  const clientesUrgentes = insights.pending
    .filter((p) => p.nivel === 'critico')
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .map((p) => ({
      conversa_id: p.conversa_id,
      cliente_nome: p.cliente_nome,
      telefone: p.telefone,
      foto: p.foto_perfil,
      departamento: p.departamento_nome,
      atendente_id: p.atendente_id,
      atendente_nome: p.atendente_nome,
      ultima_mensagem_texto: p.ultima_mensagem_texto,
      ultima_mensagem_em: p.ultima_mensagem_em,
      minutos_aguardando: p.minutos_aguardando,
      nivel: p.nivel,
      motivo: `Cliente aguardando resposta há ${p.minutos_aguardando} minutos`,
    }))

  return {
    sla_minutos_sem_resposta: insights.slaMinutes,
    cards: {
      atendimentos_abertos: insights.conversations.length,
      aguardando_funcionario: insights.pending.length,
      atrasados: insights.pending.filter((p) => p.atrasado).length,
      tempo_medio_resposta_minutos: tempoMedioGlobal,
    },
    funcionarios,
    clientes_urgentes: clientesUrgentes,
  }
}

async function getClientesPendentes(companyId, filters) {
  const insights = await buildConversationInsights(companyId)
  const filtered = filterPendingItems(insights.pending, filters)

  return {
    sla_minutos_sem_resposta: insights.slaMinutes,
    total: filtered.length,
    clientes: filtered.map((item) => ({
      conversa_id: item.conversa_id,
      cliente_nome: item.cliente_nome,
      telefone: item.telefone,
      foto_perfil: item.foto_perfil,
      departamento_id: item.departamento_id,
      departamento_nome: item.departamento_nome,
      atendente_id: item.atendente_id,
      atendente_nome: item.atendente_nome,
      ultima_mensagem_texto: item.ultima_mensagem_texto,
      ultima_mensagem_em: item.ultima_mensagem_em,
      minutos_aguardando: item.minutos_aguardando,
      nivel: item.nivel,
      status_atendimento: item.status_atendimento,
      pode_abrir_conversa: true,
    })),
  }
}

async function getMovimentacaoFuncionario(companyId, usuarioId) {
  const [usuario, insights, atendimentosHoje] = await Promise.all([
    supabase
      .from('usuarios')
      .select('id, nome, perfil')
      .eq('company_id', companyId)
      .eq('id', usuarioId)
      .maybeSingle(),
    buildConversationInsights(companyId),
    listAtendimentosToday(companyId),
  ])

  if (usuario.error) throw usuario.error
  if (!usuario.data) {
    const err = new Error('Funcionário não encontrado')
    err.statusCode = 404
    throw err
  }

  const assignedConversations = insights.conversations.filter((c) => Number(c.atendente_id) === Number(usuarioId))
  const pendingAssigned = insights.pending.filter((p) => Number(p.atendente_id) === Number(usuarioId))
  const atrasados = pendingAssigned.filter((p) => p.atrasado)

  const convIds = assignedConversations.map((c) => c.id)
  const tempoMedio = await calculateAvgResponseMinutes(companyId, convIds, startOfToday())

  const movimentosUsuario = atendimentosHoje.filter((a) => Number(a.de_usuario_id) === Number(usuarioId) || Number(a.para_usuario_id) === Number(usuarioId))
  const eventoConvIds = [...new Set(movimentosUsuario.map((m) => m.conversa_id).filter((id) => id != null))]

  let convMap = new Map()
  if (eventoConvIds.length > 0) {
    const { data: conversasEventos, error: errConvs } = await supabase
      .from('conversas')
      .select('id, telefone, nome_contato_cache, clientes!conversas_cliente_fk ( id, nome, pushname )')
      .eq('company_id', companyId)
      .in('id', eventoConvIds)
    if (errConvs) throw errConvs
    convMap = new Map((conversasEventos || []).map((c) => [c.id, c]))
  }

  const eventosHoje = movimentosUsuario.map((mov) => {
    const conv = convMap.get(mov.conversa_id)
    const tipo = mov.acao === 'assumiu'
      ? 'assumiu'
      : mov.acao === 'encerrou'
        ? 'encerrou'
        : mov.acao === 'transferiu' && Number(mov.para_usuario_id) === Number(usuarioId)
          ? 'transferencia_recebida'
          : mov.acao || 'movimentacao'
    return {
      tipo,
      conversa_id: mov.conversa_id,
      cliente_nome: getDisplayName(conv?.clientes) || conv?.nome_contato_cache || conv?.telefone || null,
      criado_em: mov.criado_em,
    }
  })

  const conversasEmAberto = pendingAssigned
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .map((p) => ({
      conversa_id: p.conversa_id,
      cliente_nome: p.cliente_nome,
      telefone: p.telefone,
      departamento: p.departamento_nome,
      status_atendimento: p.status_atendimento,
      ultima_mensagem_texto: p.ultima_mensagem_texto,
      ultima_mensagem_direcao: 'in',
      minutos_aguardando: p.minutos_aguardando,
      nivel: p.nivel,
    }))

  return {
    funcionario: {
      usuario_id: usuario.data.id,
      nome: usuario.data.nome || 'Sem nome',
      perfil: usuario.data.perfil || null,
    },
    resumo_hoje: {
      atendimentos_assumidos: movimentosUsuario.filter((a) => a.acao === 'assumiu').length,
      atendimentos_transferidos_recebidos: movimentosUsuario.filter((a) => a.acao === 'transferiu' && Number(a.para_usuario_id) === Number(usuarioId)).length,
      atendimentos_finalizados: movimentosUsuario.filter((a) => a.acao === 'encerrou').length,
      clientes_sem_resposta: pendingAssigned.length,
      clientes_atrasados: atrasados.length,
      tempo_medio_resposta_minutos: tempoMedio,
    },
    conversas_em_aberto: conversasEmAberto,
    eventos_hoje: eventosHoje,
  }
}

module.exports = {
  getResumo,
  getClientesPendentes,
  getMovimentacaoFuncionario,
}
