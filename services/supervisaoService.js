const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')

const OPEN_STATUSES = ['aberta', 'em_atendimento', 'aguardando_cliente']
const PENDING_STATUSES = ['aberta', 'em_atendimento']
const DEFAULT_SLA_MINUTES = 30
const DEFAULT_DELAY_MINUTES = 30

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

function buildPriorityThresholds() {
  return {
    atencaoAt: 10,
    prioritarioAt: 30,
    criticoAt: 60,
  }
}

function getNivel(minutosAguardando) {
  const thresholds = buildPriorityThresholds()
  if (minutosAguardando > thresholds.criticoAt) return 'critico'
  if (minutosAguardando > thresholds.prioritarioAt) return 'prioritario'
  if (minutosAguardando >= thresholds.atencaoAt) return 'atencao'
  return 'normal'
}

function getStatusRank(nivel) {
  if (nivel === 'critico') return 0
  if (nivel === 'prioritario') return 1
  if (nivel === 'atencao') return 2
  return 3
}

function minutesSince(isoDate) {
  if (!isoDate) return 0
  const diff = Date.now() - new Date(isoDate).getTime()
  return Math.max(0, Math.floor(diff / 60000))
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '')
}

/** Conversas abertas do atendente com status `em_atendimento`. */
function countConversasEmAtendimento(conversations, usuarioId) {
  const uid = Number(usuarioId)
  return (conversations || []).filter(
    (c) =>
      Number(c.atendente_id) === uid &&
      String(c.status_atendimento || '').toLowerCase() === 'em_atendimento'
  ).length
}

const MSG_STATS_PAGE = 1000
/** Evita URL/query enorme em `.in()` quando há muitas conversas abertas. */
const CONV_ID_IN_CHUNK = 120

/**
 * Carrega todas as mensagens in/out para cálculo de SLA/tempo médio.
 * PostgREST limita ~1000 linhas por request — sem paginação o tempo médio global zera com volume alto.
 */
async function fetchMensagensInOutPaginated(companyId, conversationIds, { fromDate = null, toDateExclusive = null } = {}) {
  const ids = [...new Set((conversationIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!ids.length) return []

  async function fetchChunk(convIds) {
    const all = []
    let offset = 0
    for (;;) {
      let q = supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao')
        .eq('company_id', companyId)
        .in('conversa_id', convIds)
        .in('direcao', ['in', 'out'])
        .not('criado_em', 'is', null)
        .order('criado_em', { ascending: true, nullsFirst: false })
      if (fromDate) q = q.gte('criado_em', fromDate.toISOString())
      if (toDateExclusive) q = q.lt('criado_em', toDateExclusive.toISOString())
      q = q.range(offset, offset + MSG_STATS_PAGE - 1)
      const { data, error } = await q
      if (error) throw error
      const rows = data || []
      all.push(...rows)
      if (rows.length < MSG_STATS_PAGE) break
      offset += MSG_STATS_PAGE
    }
    return all
  }

  if (ids.length <= CONV_ID_IN_CHUNK) return fetchChunk(ids)

  const parts = []
  for (let i = 0; i < ids.length; i += CONV_ID_IN_CHUNK) {
    parts.push(await fetchChunk(ids.slice(i, i + CONV_ID_IN_CHUNK)))
  }
  const merged = parts.flat()
  merged.sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime())
  return merged
}

/**
 * Garante valor seguro para renderização no React (nunca retorna objeto/array cru).
 * JSON/objetos viram string; evita erro "Objects are not valid as a React child".
 */
function safeDisplayString(value, maxLen = 500) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') {
    const s = value.trim()
    return maxLen ? s.slice(0, maxLen) : s
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value)
      return maxLen ? s.slice(0, maxLen) : s
    } catch {
      return ''
    }
  }
  const s = String(value)
  return maxLen ? s.slice(0, maxLen) : s
}

/** URL ou texto curto para foto; rejeita objetos */
function safePhotoUrl(value) {
  if (value == null) return null
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

/** FK numérica positiva (evita objeto/embed acidental no JSON). */
function safeFkId(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

/**
 * Objeto final da API: só primitivos aceitos pelo React (sem POJOs aninhados).
 */
function toPendingApiShape(raw) {
  const nivelOk = ['normal', 'atencao', 'prioritario', 'critico'].includes(String(raw.nivel))
    ? raw.nivel
    : 'normal'
  return {
    conversa_id: safeFkId(raw.conversa_id),
    cliente_nome: safeDisplayString(raw.cliente_nome, 200),
    telefone: raw.telefone != null ? safeDisplayString(raw.telefone, 40) : null,
    foto_perfil: safePhotoUrl(raw.foto_perfil),
    departamento_id: safeFkId(raw.departamento_id),
    departamento_nome: safeDisplayString(raw.departamento_nome, 120),
    atendente_id: safeFkId(raw.atendente_id),
    atendente_nome: raw.atendente_nome != null ? safeDisplayString(raw.atendente_nome, 120) : null,
    ultima_mensagem_texto: safeDisplayString(raw.ultima_mensagem_texto, 2000),
    ultima_mensagem_em: typeof raw.ultima_mensagem_em === 'string' ? raw.ultima_mensagem_em : null,
    ultima_mensagem_direcao: raw.ultima_mensagem_direcao === 'out' ? 'out' : 'in',
    resumo_conversa: safeDisplayString(raw.resumo_conversa, 180),
    minutos_aguardando: Math.max(0, Math.floor(Number(raw.minutos_aguardando) || 0)),
    nivel: nivelOk,
    status_atendimento: safeDisplayString(raw.status_atendimento, 80),
    aguardando_funcionario: !!raw.aguardando_funcionario,
    atrasado: !!raw.atrasado,
    pode_abrir_conversa: !!raw.pode_abrir_conversa,
  }
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

  return {
    slaMinutes,
    usingDefault,
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
  const baseSelect = `
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
  `
  const selectWithResumo = `${baseSelect}, resumo_ia`

  let useResumo = true
  const all = []
  let offset = 0

  for (;;) {
    const sel = useResumo ? selectWithResumo : baseSelect
    let { data: rows, error } = await supabase
      .from('conversas')
      .select(sel)
      .eq('company_id', companyId)
      .in('status_atendimento', OPEN_STATUSES)
      .order('criado_em', { ascending: false })
      .range(offset, offset + MSG_STATS_PAGE - 1)

    if (error && useResumo) {
      useResumo = false
      all.length = 0
      offset = 0
      ;({ data: rows, error } = await supabase
        .from('conversas')
        .select(baseSelect)
        .eq('company_id', companyId)
        .in('status_atendimento', OPEN_STATUSES)
        .order('criado_em', { ascending: false })
        .range(offset, offset + MSG_STATS_PAGE - 1))
    }
    if (error) throw error
    rows = rows || []
    all.push(...rows)
    if (rows.length < MSG_STATS_PAGE) break
    offset += MSG_STATS_PAGE
  }

  return all
}

/**
 * Última mensagem in/out por conversa. Pagina para não truncar em ~1000 linhas globais.
 * Chaves do Map são sempre Number(conversa_id) para bater com conversa.id do Postgres/JS.
 */
async function listLastMessagesByConversation(companyId, conversationIds) {
  const normalizeIds = [...new Set((conversationIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!normalizeIds.length) return new Map()

  async function fetchSlice(idsSlice) {
    const needed = new Set(idsSlice)
    const map = new Map()
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('mensagens')
        .select('conversa_id, direcao, texto, tipo, criado_em')
        .eq('company_id', companyId)
        .in('conversa_id', idsSlice)
        .in('direcao', ['in', 'out'])
        .not('criado_em', 'is', null)
        .order('criado_em', { ascending: false, nullsFirst: false })
        .range(offset, offset + MSG_STATS_PAGE - 1)
      if (error) throw error
      const rows = data || []
      for (const msg of rows) {
        const cid = Number(msg.conversa_id)
        if (!needed.has(cid)) continue
        if (!map.has(cid)) map.set(cid, msg)
      }
      if (rows.length < MSG_STATS_PAGE) break
      offset += MSG_STATS_PAGE
      if (map.size >= needed.size) break
    }
    return map
  }

  if (normalizeIds.length <= CONV_ID_IN_CHUNK) return fetchSlice(normalizeIds)

  const merged = new Map()
  for (let i = 0; i < normalizeIds.length; i += CONV_ID_IN_CHUNK) {
    const slice = normalizeIds.slice(i, i + CONV_ID_IN_CHUNK)
    const part = await fetchSlice(slice)
    for (const [k, v] of part) {
      if (!merged.has(k)) merged.set(k, v)
    }
  }
  return merged
}

function hasValidResumoIA(conversa) {
  const ia = conversa?.resumo_ia
  if (ia == null || ia === '') return false
  if (typeof ia === 'string') return !!ia.trim()
  if (typeof ia === 'object') return Object.keys(ia).length > 0
  return true
}

function buildMessageTypeResumo(lastMessage) {
  const tipo = String(lastMessage?.tipo || '').toLowerCase()
  const dir = String(lastMessage?.direcao || '').toLowerCase() === 'out' ? 'Atendente' : 'Cliente'
  if (tipo === 'imagem') return `${dir} enviou imagem`
  if (tipo === 'audio') return `${dir} enviou áudio`
  if (tipo === 'video') return `${dir} enviou vídeo`
  if (tipo === 'arquivo') return `${dir} enviou documento`
  if (tipo === 'sticker') return `${dir} enviou figurinha`
  if (tipo === 'contact') return `${dir} enviou contato`
  if (tipo === 'location') return `${dir} enviou localização`
  return null
}

function buildResumoConversa(conversa, lastMessage) {
  if (hasValidResumoIA(conversa)) {
    const ia = conversa.resumo_ia
    if (typeof ia === 'string') return ia.trim().slice(0, 180)
    return safeDisplayString(ia, 180)
  }
  const text = safeDisplayString(lastMessage?.texto, 180)
  if (text) return text
  const byType = buildMessageTypeResumo(lastMessage)
  if (byType) return byType
  return 'Sem resumo disponível'
}

function buildPendingItem(conversa, lastMessage, depMap) {
  if (!lastMessage || lastMessage.direcao !== 'in') return null
  if (!PENDING_STATUSES.includes(String(conversa.status_atendimento || '').toLowerCase())) return null

  const minutosAguardando = minutesSince(lastMessage.criado_em)
  const nivel = getNivel(minutosAguardando)
  const departamentoNome = conversa.departamento_id != null
    ? depMap[String(conversa.departamento_id)] || 'Sem departamento'
    : 'Sem departamento'
  const clienteObj = conversa.clientes || null
  const clienteNome = safeDisplayString(
    getDisplayName(clienteObj) || conversa.nome_contato_cache || conversa.telefone || 'Cliente',
    200
  )
  const resumoConversa = buildResumoConversa(conversa, lastMessage)

  return toPendingApiShape({
    conversa_id: conversa.id,
    cliente_nome: clienteNome,
    telefone: safeDisplayString(conversa.telefone || clienteObj?.telefone || '', 40) || null,
    foto_perfil: safePhotoUrl(clienteObj?.foto_perfil) || safePhotoUrl(conversa.foto_perfil_contato_cache),
    departamento_id: conversa.departamento_id,
    departamento_nome: departamentoNome,
    atendente_id: conversa.atendente_id,
    atendente_nome: conversa.usuarios?.nome != null ? safeDisplayString(conversa.usuarios.nome, 120) : null,
    ultima_mensagem_texto: safeDisplayString(lastMessage.texto, 2000),
    ultima_mensagem_em: lastMessage.criado_em || null,
    ultima_mensagem_direcao: lastMessage.direcao,
    resumo_conversa: resumoConversa,
    minutos_aguardando: minutosAguardando,
    nivel,
    status_atendimento: conversa.status_atendimento,
    aguardando_funcionario: true,
    atrasado: minutosAguardando > DEFAULT_DELAY_MINUTES,
    pode_abrir_conversa: true,
  })
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
    const lastMessage = lastMessagesMap.get(Number(conversa.id))
    if (!lastMessage) continue
    if (lastMessage.direcao === 'out') {
      aguardandoCliente.push({
        conversa_id: safeFkId(conversa.id),
        status_atendimento: safeDisplayString(conversa.status_atendimento, 80),
      })
      continue
    }
    const pendingItem = buildPendingItem(conversa, lastMessage, depMap)
    if (pendingItem) pending.push(pendingItem)
  }

  return {
    slaMinutes: slaConfig.slaMinutes,
    thresholds: buildPriorityThresholds(),
    conversations,
    pending,
    aguardandoCliente,
  }
}

async function calculateAvgResponseMinutes(companyId, conversationIds, fromDate, toDateExclusive = null) {
  if (!conversationIds?.length) return null

  const data = await fetchMensagensInOutPaginated(companyId, conversationIds, {
    fromDate,
    toDateExclusive,
  })

  const byConversation = new Map()
  for (const m of data || []) {
    const cid = Number(m.conversa_id)
    if (!Number.isFinite(cid)) continue
    if (!byConversation.has(cid)) byConversation.set(cid, [])
    byConversation.get(cid).push(m)
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

async function calculateResponseStatsByConversation(companyId, conversations, fromDate, toDateExclusive = null) {
  const conversationIds = (conversations || []).map((c) => c.id).filter((id) => id != null)
  if (!conversationIds.length) {
    return {
      globalAverage: null,
      byConversation: new Map(),
    }
  }

  const data = await fetchMensagensInOutPaginated(companyId, conversationIds, {
    fromDate,
    toDateExclusive,
  })

  const byConversationRows = new Map()
  for (const row of data || []) {
    const cid = Number(row.conversa_id)
    if (!Number.isFinite(cid)) continue
    if (!byConversationRows.has(cid)) byConversationRows.set(cid, [])
    byConversationRows.get(cid).push(row)
  }

  const avgByConversation = new Map()
  let globalMinutes = 0
  let globalPairs = 0

  for (const [convId, rows] of byConversationRows.entries()) {
    let pendingIn = null
    let convPairs = 0
    let convMinutes = 0
    for (const row of rows) {
      if (row.direcao === 'in' && pendingIn == null) {
        pendingIn = row
        continue
      }
      if (row.direcao === 'out' && pendingIn) {
        const diff = (new Date(row.criado_em).getTime() - new Date(pendingIn.criado_em).getTime()) / 60000
        if (diff >= 0) {
          convMinutes += diff
          convPairs += 1
          globalMinutes += diff
          globalPairs += 1
        }
        pendingIn = null
      }
    }
    if (convPairs > 0) {
      avgByConversation.set(convId, Number((convMinutes / convPairs).toFixed(2)))
    }
  }

  return {
    globalAverage: globalPairs > 0 ? Number((globalMinutes / globalPairs).toFixed(2)) : null,
    byConversation: avgByConversation,
  }
}

async function listAtendimentosToday(companyId) {
  const todayIso = startOfToday().toISOString()
  const all = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('atendimentos')
      .select('id, conversa_id, acao, criado_em, de_usuario_id, para_usuario_id')
      .eq('company_id', companyId)
      .gte('criado_em', todayIso)
      .order('criado_em', { ascending: false })
      .range(offset, offset + MSG_STATS_PAGE - 1)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < MSG_STATS_PAGE) break
    offset += MSG_STATS_PAGE
  }
  return all
}

/** Movimentações na tabela `atendimentos` em [start, end). */
async function listAtendimentosDayRange(companyId, start, end) {
  const all = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('atendimentos')
      .select('id, conversa_id, acao, criado_em, de_usuario_id, para_usuario_id')
      .eq('company_id', companyId)
      .gte('criado_em', start.toISOString())
      .lt('criado_em', end.toISOString())
      .order('criado_em', { ascending: false })
      .range(offset, offset + MSG_STATS_PAGE - 1)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < MSG_STATS_PAGE) break
    offset += MSG_STATS_PAGE
  }
  return all
}

async function listUsuariosCompany(companyId) {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, perfil')
    .eq('company_id', companyId)
    .order('nome', { ascending: true })
  if (error) throw error
  const uniqueById = new Map()
  for (const user of data || []) {
    if (user?.id == null) continue
    uniqueById.set(Number(user.id), user)
  }
  return Array.from(uniqueById.values())
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
  const [usuarios, atendimentosHoje, responseStats] = await Promise.all([
    listUsuariosCompany(companyId),
    listAtendimentosToday(companyId),
    calculateResponseStatsByConversation(companyId, insights.conversations, startOfToday()),
  ])

  const funcionarios = usuarios.map((u) => {
    const assignedOpen = insights.conversations.filter((c) => Number(c.atendente_id) === Number(u.id))
    const assignedPending = insights.pending.filter((p) => Number(p.atendente_id) === Number(u.id))
    const atrasados = assignedPending.filter((p) => p.atrasado)
    const assumidos = atendimentosHoje.filter((a) => a.acao === 'assumiu' && (Number(a.para_usuario_id) === Number(u.id) || Number(a.de_usuario_id) === Number(u.id))).length
    const mediasAtendente = assignedOpen
      .map((c) => responseStats.byConversation.get(Number(c.id)))
      .filter((x) => Number.isFinite(Number(x)))
    const mediaAtendente = mediasAtendente.length > 0
      ? Number((mediasAtendente.reduce((acc, x) => acc + Number(x), 0) / mediasAtendente.length).toFixed(2))
      : null
    const maiorTempo = assignedPending.length > 0 ? Math.max(...assignedPending.map((p) => p.minutos_aguardando)) : 0
    const emAtendimento = countConversasEmAtendimento(assignedOpen, u.id)
    const nivel = assignedPending.some((p) => p.nivel === 'critico')
      ? 'critico'
      : assignedPending.some((p) => p.nivel === 'prioritario')
        ? 'prioritario'
      : assignedPending.some((p) => p.nivel === 'atencao')
        ? 'atencao'
        : 'normal'

    return {
      usuario_id: u.id,
      nome: safeDisplayString(u.nome || 'Sem nome', 120),
      perfil: u.perfil != null ? safeDisplayString(u.perfil, 40) : null,
      atendimentos_assumidos_hoje: assumidos,
      /** Alias semântico: mesma contagem de eventos `assumiu` no dia (timezone servidor). */
      atendimentos_assumidos_no_dia: assumidos,
      atendimentos_em_aberto: assignedOpen.length,
      conversas_em_atendimento: emAtendimento,
      clientes_sem_resposta: assignedPending.length,
      clientes_atrasados: atrasados.length,
      tempo_medio_resposta_minutos: mediaAtendente,
      maior_tempo_sem_resposta_minutos: maiorTempo,
      nivel,
    }
  })

  const clientesUrgentes = insights.pending
    .filter((p) => p.nivel === 'critico')
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .map((p) => ({
      conversa_id: p.conversa_id,
      cliente_nome: safeDisplayString(p.cliente_nome, 200),
      telefone: p.telefone != null ? safeDisplayString(p.telefone, 40) : null,
      foto: safePhotoUrl(p.foto_perfil),
      departamento: safeDisplayString(p.departamento_nome, 120),
      atendente_id: p.atendente_id,
      atendente_nome: p.atendente_nome != null ? safeDisplayString(p.atendente_nome, 120) : null,
      ultima_mensagem_texto: safeDisplayString(p.ultima_mensagem_texto, 2000),
      ultima_mensagem_em: p.ultima_mensagem_em,
      resumo_conversa: safeDisplayString(p.resumo_conversa, 180),
      minutos_aguardando: p.minutos_aguardando,
      nivel: p.nivel,
      motivo: `Cliente aguardando resposta há ${p.minutos_aguardando} minutos`,
    }))

  return {
    sla_minutos_sem_resposta: insights.slaMinutes,
    slaMinutosSemResposta: insights.slaMinutes,
    cards: {
      atendimentos_abertos: insights.conversations.length,
      atendimentosAbertos: insights.conversations.length,
      aguardando_funcionario: insights.pending.length,
      aguardandoFuncionario: insights.pending.length,
      /** Última mensagem do cliente, mas conversa sem atendente — não entram no ranking por funcionário. */
      aguardando_sem_atribuicao: insights.pending.filter((p) => p.atendente_id == null).length,
      aguardandoSemAtribuicao: insights.pending.filter((p) => p.atendente_id == null).length,
      atrasados: insights.pending.filter((p) => p.atrasado).length,
      atrasados_30min: insights.pending.filter((p) => p.minutos_aguardando > DEFAULT_DELAY_MINUTES).length,
      tempo_medio_resposta_minutos: responseStats.globalAverage,
      tempoMedioRespostaMinutos: responseStats.globalAverage,
    },
    funcionarios,
    equipe_hoje: funcionarios,
    equipeHoje: funcionarios,
    clientes_urgentes: clientesUrgentes,
    clientesUrgentes,
  }
}

async function getClientesPendentes(companyId, filters) {
  const insights = await buildConversationInsights(companyId)
  const filtered = filterPendingItems(insights.pending, filters)

  return {
    sla_minutos_sem_resposta: insights.slaMinutes,
    slaMinutosSemResposta: insights.slaMinutes,
    total: filtered.length,
    total_clientes: filtered.length,
    totalClientes: filtered.length,
    clientes: filtered.map((item) => ({
      conversa_id: item.conversa_id,
      cliente_nome: safeDisplayString(item.cliente_nome, 200),
      telefone: item.telefone != null ? safeDisplayString(item.telefone, 40) : null,
      foto_perfil: safePhotoUrl(item.foto_perfil),
      departamento_id: item.departamento_id,
      departamento_nome: safeDisplayString(item.departamento_nome, 120),
      atendente_id: item.atendente_id,
      atendente_nome: item.atendente_nome != null ? safeDisplayString(item.atendente_nome, 120) : null,
      ultima_mensagem_texto: safeDisplayString(item.ultima_mensagem_texto, 2000),
      ultima_mensagem_em: item.ultima_mensagem_em,
      resumo_conversa: safeDisplayString(item.resumo_conversa, 180),
      minutos_aguardando: item.minutos_aguardando,
      nivel: item.nivel,
      status_atendimento: item.status_atendimento,
      pode_abrir_conversa: true,
    })),
    clientes_pendentes: filtered.map((item) => ({
      conversa_id: item.conversa_id,
      cliente_nome: safeDisplayString(item.cliente_nome, 200),
      telefone: item.telefone != null ? safeDisplayString(item.telefone, 40) : null,
      foto_perfil: safePhotoUrl(item.foto_perfil),
      departamento_id: item.departamento_id,
      departamento_nome: safeDisplayString(item.departamento_nome, 120),
      atendente_id: item.atendente_id,
      atendente_nome: item.atendente_nome != null ? safeDisplayString(item.atendente_nome, 120) : null,
      ultima_mensagem_texto: safeDisplayString(item.ultima_mensagem_texto, 2000),
      ultima_mensagem_em: item.ultima_mensagem_em,
      resumo_conversa: safeDisplayString(item.resumo_conversa, 180),
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
      cliente_nome: safeDisplayString(
        getDisplayName(conv?.clientes) || conv?.nome_contato_cache || conv?.telefone || '',
        200
      ) || null,
      criado_em: mov.criado_em,
    }
  })

  const conversasEmAberto = pendingAssigned
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .map((p) => ({
      conversa_id: p.conversa_id,
      cliente_nome: safeDisplayString(p.cliente_nome, 200),
      telefone: p.telefone != null ? safeDisplayString(p.telefone, 40) : null,
      departamento: safeDisplayString(p.departamento_nome, 120),
      status_atendimento: p.status_atendimento,
      ultima_mensagem_texto: safeDisplayString(p.ultima_mensagem_texto, 2000),
      ultima_mensagem_direcao: 'in',
      resumo_conversa: safeDisplayString(p.resumo_conversa, 180),
      minutos_aguardando: p.minutos_aguardando,
      nivel: p.nivel,
    }))

  return {
    funcionario: {
      usuario_id: usuario.data.id,
      nome: safeDisplayString(usuario.data.nome || 'Sem nome', 120),
      perfil: usuario.data.perfil != null ? safeDisplayString(usuario.data.perfil, 40) : null,
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

function parseDateInput(dateStr) {
  if (!dateStr) return null
  const raw = String(dateStr).trim()
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const dt = new Date(y, mo, d, 0, 0, 0, 0)
  if (Number.isNaN(dt.getTime())) return null
  return dt
}

function getDayRange(dateInput) {
  const start = dateInput ? new Date(dateInput) : startOfToday()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

async function getRelatorioDiarioGestor(companyId, dateStr) {
  const parsedDate = parseDateInput(dateStr)
  if (dateStr && !parsedDate) {
    const err = new Error('Data inválida. Use formato YYYY-MM-DD')
    err.statusCode = 400
    throw err
  }
  const { start, end } = getDayRange(parsedDate)
  const insights = await buildConversationInsights(companyId)
  const [atendimentosRows, responseStats] = await Promise.all([
    listAtendimentosDayRange(companyId, start, end),
    calculateResponseStatsByConversation(companyId, insights.conversations, start, end),
  ])

  const funcionariosBase = await listUsuariosCompany(companyId)
  const ranking = funcionariosBase.map((u) => {
    const convsUser = insights.conversations.filter((c) => Number(c.atendente_id) === Number(u.id))
    const pendUser = insights.pending.filter((p) => Number(p.atendente_id) === Number(u.id))
    const medias = convsUser
      .map((c) => responseStats.byConversation.get(Number(c.id)))
      .filter((x) => Number.isFinite(Number(x)))
    const tempoMedio = medias.length ? Number((medias.reduce((a, b) => a + Number(b), 0) / medias.length).toFixed(2)) : null
    const assumidosNoDia = atendimentosRows.filter(
      (a) =>
        a.acao === 'assumiu' &&
        (Number(a.para_usuario_id) === Number(u.id) || Number(a.de_usuario_id) === Number(u.id))
    ).length
    const emAtendimento = countConversasEmAtendimento(convsUser, u.id)
    return {
      usuario_id: u.id,
      nome: safeDisplayString(u.nome || 'Sem nome', 120),
      atendimentos_assumidos_hoje: assumidosNoDia,
      atendimentos_assumidos_no_dia: assumidosNoDia,
      conversas_em_atendimento: emAtendimento,
      clientes_sem_resposta: pendUser.length,
      maior_tempo_sem_resposta_minutos: pendUser.length ? Math.max(...pendUser.map((p) => p.minutos_aguardando)) : 0,
      tempo_medio_resposta_minutos: tempoMedio,
    }
  }).sort((a, b) => {
    if (b.atendimentos_assumidos_hoje !== a.atendimentos_assumidos_hoje) return b.atendimentos_assumidos_hoje - a.atendimentos_assumidos_hoje
    return b.clientes_sem_resposta - a.clientes_sem_resposta
  })

  const setorCount = {}
  for (const conv of insights.conversations) {
    const dep = conv.departamento_id == null ? 'Sem departamento' : String(conv.departamento_id)
    setorCount[dep] = (setorCount[dep] || 0) + 1
  }
  const depIds = Object.keys(setorCount).filter((x) => x !== 'Sem departamento').map((x) => Number(x))
  const depMap = await listDepartamentosMap(companyId, depIds)
  const setores = Object.entries(setorCount).map(([depId, total]) => ({
    departamento_id: depId === 'Sem departamento' ? null : Number(depId),
    departamento_nome: depId === 'Sem departamento' ? depId : (depMap[depId] || 'Sem departamento'),
    total_conversas: total,
  })).sort((a, b) => b.total_conversas - a.total_conversas)

  const criticos = insights.pending
    .filter((p) => p.nivel === 'critico' || p.minutos_aguardando > DEFAULT_DELAY_MINUTES)
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .slice(0, 20)
    .map((p) => ({
      conversa_id: p.conversa_id,
      cliente_nome: safeDisplayString(p.cliente_nome, 200),
      telefone: p.telefone != null ? safeDisplayString(p.telefone, 40) : null,
      atendente_nome: p.atendente_nome != null ? safeDisplayString(p.atendente_nome, 120) : null,
      departamento_nome: safeDisplayString(p.departamento_nome, 120),
      minutos_aguardando: p.minutos_aguardando,
      nivel: p.nivel,
      resumo_conversa: safeDisplayString(p.resumo_conversa, 180),
    }))

  return {
    data_referencia: start.toISOString().slice(0, 10),
    periodo: {
      inicio: start.toISOString(),
      fim: end.toISOString(),
    },
    totais: {
      /** Quantidade de linhas na tabela `atendimentos` no dia (movimentações — não é conversas abertas). */
      registros_movimentacao_dia: atendimentosRows.length,
      atendimentos_dia: atendimentosRows.length,
      /** Conversas com status aberta/em_atendimento/aguardando_cliente (painel “Atendimentos abertos”). */
      atendimentos_abertos: insights.conversations.length,
      conversas_abertas: insights.conversations.length,
      aguardando_funcionario: insights.pending.length,
      aguardando_sem_atribuicao: insights.pending.filter((p) => p.atendente_id == null).length,
      atrasados_30min: insights.pending.filter((p) => p.minutos_aguardando > DEFAULT_DELAY_MINUTES).length,
      tempo_medio_resposta_minutos: responseStats.globalAverage,
      tempoMedioRespostaMinutos: responseStats.globalAverage,
    },
    ranking_funcionarios: ranking,
    departamentos_maior_demanda: setores,
    clientes_criticos: criticos,
  }
}

module.exports = {
  getResumo,
  getClientesPendentes,
  getMovimentacaoFuncionario,
  getRelatorioDiarioGestor,
}
