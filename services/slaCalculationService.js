/**
 * Cálculo centralizado de SLA — primeira resposta, reabertura, horário comercial,
 * exclusão de bot/automação e metas por empresa/setor/atendente.
 */
const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')
const { looksLikeBotMessage } = require('./chatbotTriageService')
const {
  loadChatbotTriageMergeAndAbsence,
  outboundQualificaParaAguardandoCliente,
} = require('./absenceFinalizationService')
const {
  businessMinutesBetween,
} = require('./atendimentoSemRespostaService')
const {
  resolveDashboardInstanceScope,
  applyDashboardInstanceScope,
} = require('./dashboardInstanceScopeService')
const {
  explicitMessageOrigin,
  dedupeOperationalMessages,
  isIndividualCustomerConversation,
} = require('./dashboardDataRulesService')

const SAO_PAULO_TZ = 'America/Sao_Paulo'
const SLA_BUSINESS_START_MINUTE = 7 * 60
const SLA_BUSINESS_END_MINUTE = 18 * 60
const PAGE_SIZE = 1000
const OPEN_STATUSES = new Set(['aberta', 'em_atendimento', 'aguardando_cliente'])

const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

function clampInt(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  return Math.max(min, Math.min(max, Math.trunc(x)))
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function percent(part, total) {
  if (!total) return null
  return Math.round((part / total) * 1000) / 10
}

function avg(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v))
  if (nums.length === 0) return null
  return nums.reduce((sum, v) => sum + v, 0) / nums.length
}

function parseDateOnly(value) {
  const s = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return { y, m, d, value: s }
}

function saoPauloDateStartIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 3, 0, 0, 0)).toISOString()
}

function saoPauloDateEndIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + 1, 2, 59, 59, 999)).toISOString()
}

function formatSaoPauloDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = {}
  for (const part of parts) map[part.type] = part.value
  return `${map.year}-${map.month}-${map.day}`
}

function saoPauloHourKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const hour = parts.find((p) => p.type === 'hour')?.value
  return hour != null ? `${hour}:00` : null
}

function saoPauloWeekdayIndex(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    weekday: 'short',
  }).formatToParts(date)
  const wd = parts.find((p) => p.type === 'weekday')?.value
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return wd != null ? map[wd] ?? null : null
}

function todaySaoPauloDateKey() {
  return formatSaoPauloDateKey(new Date())
}

function addDaysDateKey(dateKey, days) {
  const parsed = parseDateOnly(dateKey)
  if (!parsed) return todaySaoPauloDateKey()
  return formatSaoPauloDateKey(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + days, 12, 0, 0, 0)))
}

function getDateRangeFromQuery(query = {}) {
  const today = todaySaoPauloDateKey()
  const dataFim = parseDateOnly(query.data_fim)?.value || today
  const dataInicio = parseDateOnly(query.data_inicio)?.value || addDaysDateKey(dataFim, -6)
  return {
    data_inicio: dataInicio,
    data_fim: dataFim,
    fromIso: saoPauloDateStartIso(dataInicio),
    toIso: saoPauloDateEndIso(dataFim),
  }
}

function getPreviousPeriodRange(range) {
  const startParsed = parseDateOnly(range.data_inicio)
  const endParsed = parseDateOnly(range.data_fim)
  if (!startParsed || !endParsed) return null
  const startMs = Date.UTC(startParsed.y, startParsed.m - 1, startParsed.d)
  const endMs = Date.UTC(endParsed.y, endParsed.m - 1, endParsed.d)
  const days = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1)
  const prevEnd = addDaysDateKey(range.data_inicio, -1)
  const prevStart = addDaysDateKey(prevEnd, -(days - 1))
  return {
    data_inicio: prevStart,
    data_fim: prevEnd,
    fromIso: saoPauloDateStartIso(prevStart),
    toIso: saoPauloDateEndIso(prevEnd),
  }
}

function toPositiveInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

function chunkArray(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function fetchAllRows(buildQuery) {
  const all = []
  let from = 0
  for (;;) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await buildQuery().range(from, to)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

async function loadSimpleModeOperator(company_id) {
  const [{ data: empresa, error: empresaError }, { data: usuarios, error: usuariosError }] = await Promise.all([
    supabase
      .from('empresas')
      .select('atendimento_modo_simples')
      .eq('id', company_id)
      .maybeSingle(),
    supabase
      .from('usuarios')
      .select('id, nome, perfil, ativo')
      .eq('company_id', company_id),
  ])
  if (empresaError) throw empresaError
  if (usuariosError) throw usuariosError
  if (empresa?.atendimento_modo_simples !== true) return { enabled: false, operator: null }

  const activeUsers = (usuarios || []).filter((user) => user.ativo !== false)
  const attendants = activeUsers.filter((user) => String(user.perfil || '').toLowerCase() === 'atendente')
  const operator = attendants.length === 1
    ? attendants[0]
    : activeUsers.length === 1
      ? activeUsers[0]
      : null
  return { enabled: true, operator }
}

function normalizeMinutes(value, fallback = 30) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(1440, Math.trunc(n)))
}

async function loadSlaConfig(company_id) {
  const { data: emp, error } = await supabase
    .from('empresas')
    .select('sla_minutos_sem_resposta, sla_meta_percentual, sla_usar_horario_comercial, sla_contar_bot_como_resposta, horario_inicio, horario_fim')
    .eq('id', company_id)
    .maybeSingle()
  if (error) throw error

  const [deptRows, userRows] = await Promise.all([
    supabase.from('departamentos').select('id, sla_minutos_sem_resposta').eq('company_id', company_id),
    supabase.from('usuarios').select('id, sla_minutos_sem_resposta').eq('company_id', company_id),
  ])

  const deptMap = {}
  for (const d of deptRows.data || []) {
    if (d?.id != null && d.sla_minutos_sem_resposta != null) {
      deptMap[String(d.id)] = normalizeMinutes(d.sla_minutos_sem_resposta)
    }
  }
  const userMap = {}
  for (const u of userRows.data || []) {
    if (u?.id != null && u.sla_minutos_sem_resposta != null) {
      userMap[String(u.id)] = normalizeMinutes(u.sla_minutos_sem_resposta)
    }
  }

  return {
    sla_minutos_sem_resposta: normalizeMinutes(emp?.sla_minutos_sem_resposta, 30),
    sla_meta_percentual: clampInt(emp?.sla_meta_percentual, 1, 100) ?? 90,
    // O Dashboard/SLA usa uma janela operacional fixa e auditável.
    sla_usar_horario_comercial: true,
    sla_contar_bot_como_resposta: emp?.sla_contar_bot_como_resposta === true,
    horario_inicio: '07:00',
    horario_fim: '18:00',
    metas_departamentos: deptMap,
    metas_usuarios: userMap,
  }
}

function resolveMetaMinutos(slaConfig, { atendente_id, departamento_id } = {}) {
  const empresaMin = normalizeMinutes(slaConfig?.sla_minutos_sem_resposta, 30)
  const uid = atendente_id != null ? String(atendente_id) : null
  const depId = departamento_id != null ? String(departamento_id) : null

  if (uid && slaConfig?.metas_usuarios?.[uid] != null) {
    return { limite_min: slaConfig.metas_usuarios[uid], meta_origem: 'atendente', meta_origem_label: 'Atendente' }
  }
  if (depId && slaConfig?.metas_departamentos?.[depId] != null) {
    return { limite_min: slaConfig.metas_departamentos[depId], meta_origem: 'setor', meta_origem_label: 'Setor' }
  }
  return { limite_min: empresaMin, meta_origem: 'empresa', meta_origem_label: 'Empresa' }
}

async function loadSlaBusinessSchedule(_company_id, _slaConfig) {
  // Regra única do Dashboard: todos os dias, das 07:00 às 18:00 em São Paulo.
  // Não herdamos a agenda do chatbot, pois ela pode conter janelas ou dias
  // desativados diferentes e tornaria o mesmo ciclo variável entre telas.
  const schedule = {
    enabled: true,
    timezone: SAO_PAULO_TZ,
    diasSemanaDesativados: [],
    datasEspecificasFechadas: [],
    windows: [{
      start: SLA_BUSINESS_START_MINUTE,
      end: SLA_BUSINESS_END_MINUTE,
    }],
  }

  return {
    schedule,
    horario_comercial_ativo: true,
    modo_contagem: 'horario_comercial',
    timezone: SAO_PAULO_TZ,
    dias_semana_desativados: [],
    datas_especificas_fechadas: [],
    janelas: [{ inicio: '07:00', fim: '18:00' }],
    resumo: 'Contagem ativa todos os dias, das 07:00 às 18:00, no fuso America/Sao_Paulo. Fora dessa janela, os minutos ficam pausados.',
  }
}

function calcDiffMinutes(startIso, endIso, schedule) {
  if (!startIso || !endIso) return null
  const diff = businessMinutesBetween(startIso, endIso, schedule)
  return round1(diff)
}

function classifyOutbound(msg, { triageMerged, absenceCfg, contarBot }) {
  if (!msg || msg.direcao !== 'out' || !msg.criado_em) return { tipo: null, valida: false }
  const origem = explicitMessageOrigin(msg)
  if (origem === 'sistema_humano' || origem === 'whatsapp_celular') {
    return { tipo: 'humana', origem, valida: true }
  }
  if (['automacao', 'bot', 'campanha', 'sistema'].includes(origem)) {
    return { tipo: 'automacao', origem, valida: contarBot === true }
  }
  const isHuman = outboundQualificaParaAguardandoCliente(msg.texto, msg.autor_usuario_id, triageMerged, absenceCfg)
  if (isHuman) return { tipo: 'humana', origem, valida: true }
  if (contarBot) return { tipo: 'automacao', origem, valida: true }
  const isBot = looksLikeBotMessage(String(msg.texto || ''), triageMerged) || msg.autor_usuario_id == null
  return { tipo: isBot ? 'automacao' : 'automacao', origem, valida: false }
}

function findFirstInboundAfter(msgs, afterTs = 0) {
  return (msgs || []).find((m) => {
    if (m?.direcao !== 'in' || !m?.criado_em) return false
    const ts = new Date(m.criado_em).getTime()
    return Number.isFinite(ts) && ts >= afterTs
  }) || null
}

function findFirstValidOutboundAfter(msgs, afterTs, ctx) {
  return (msgs || []).find((m) => {
    if (m?.direcao !== 'out' || !m?.criado_em) return false
    const ts = new Date(m.criado_em).getTime()
    if (!Number.isFinite(ts) || ts < afterTs) return false
    return classifyOutbound(m, ctx).valida
  }) || null
}

function findFirstAnyOutboundAfter(msgs, afterTs) {
  return (msgs || []).find((m) => {
    if (m?.direcao !== 'out' || !m?.criado_em) return false
    const ts = new Date(m.criado_em).getTime()
    return Number.isFinite(ts) && ts >= afterTs
  }) || null
}

function analyzeSlaCycle({
  msgs,
  anchorTs,
  anchorEm,
  tipoSla,
  limiteMin,
  metaOrigem,
  metaOrigemLabel,
  schedule,
  ctx,
  base,
}) {
  const primeiraIn = findFirstInboundAfter(msgs, anchorTs)
  if (!primeiraIn?.criado_em) return null

  const primeiraInTs = new Date(primeiraIn.criado_em).getTime()
  if (!Number.isFinite(primeiraInTs)) return null

  const primeiraOutValida = findFirstValidOutboundAfter(msgs, primeiraInTs, ctx)
  const primeiraOutQualquer = findFirstAnyOutboundAfter(msgs, primeiraInTs)

  const rowBase = {
    ...base,
    tipo_sla: tipoSla,
    primeira_mensagem_cliente_em: primeiraIn.criado_em,
    dia: formatSaoPauloDateKey(primeiraIn.criado_em),
    hora: saoPauloHourKey(primeiraIn.criado_em),
    dia_semana: saoPauloWeekdayIndex(primeiraIn.criado_em),
    limite_min: limiteMin,
    meta_origem: metaOrigem,
    meta_origem_label: metaOrigemLabel,
    anchor_em: anchorEm || primeiraIn.criado_em,
  }

  if (!primeiraOutValida) {
    if (primeiraOutQualquer) {
      const cls = classifyOutbound(primeiraOutQualquer, ctx)
      return {
        ...rowBase,
        primeira_resposta_em: primeiraOutQualquer.criado_em,
        tipo_resposta: cls.tipo || 'automacao',
        origem_resposta: cls.origem || explicitMessageOrigin(primeiraOutQualquer),
        status_sla: 'sem_resposta',
        cumpriu_sla: null,
        tempo_resposta_min: null,
        motivo: 'Aguardando primeira resposta humana; automação/bot não encerrou o prazo.',
      }
    }
    return {
      ...rowBase,
      primeira_resposta_em: null,
      tipo_resposta: null,
      status_sla: 'sem_resposta',
      cumpriu_sla: null,
      tempo_resposta_min: null,
      motivo: 'Aguardando primeira resposta humana.',
    }
  }

  const diffMin = calcDiffMinutes(primeiraIn.criado_em, primeiraOutValida.criado_em, schedule)
  if (diffMin == null || diffMin < 0) {
    return {
      ...rowBase,
      primeira_resposta_em: primeiraOutValida.criado_em,
      tipo_resposta: 'humana',
      status_sla: 'dados_insuficientes',
      cumpriu_sla: null,
      tempo_resposta_min: null,
      motivo: 'Não foi possível calcular o tempo entre mensagens.',
    }
  }

  const cumpriu = diffMin <= limiteMin
  const cls = classifyOutbound(primeiraOutValida, ctx)
  return {
    ...rowBase,
    primeira_resposta_em: primeiraOutValida.criado_em,
    primeira_resposta_atendente_em: primeiraOutValida.criado_em,
    tipo_resposta: cls.tipo || 'humana',
    origem_resposta: cls.origem || explicitMessageOrigin(primeiraOutValida),
    status_sla: cumpriu ? 'cumpriu' : 'violou',
    cumpriu_sla: cumpriu,
    tempo_resposta_min: diffMin,
    motivo: null,
  }
}

/**
 * Divide uma conversa persistente em ciclos operacionais de espera:
 * primeira mensagem inbound de uma rajada -> primeira resposta humana válida.
 * Inbounds consecutivas pertencem ao mesmo ciclo e bot/automação não encerram
 * a espera, salvo quando a configuração da empresa permite.
 */
function analyzeConversationSlaCycles({
  msgs,
  reopenAnchors = [],
  limiteMin,
  metaOrigem,
  metaOrigemLabel,
  schedule,
  ctx,
  base,
}) {
  const sorted = (msgs || [])
    .filter((msg) => msg?.criado_em && ['in', 'out'].includes(msg?.direcao))
    .slice()
    .sort((a, b) => {
      const diff = new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime()
      return diff || Number(a.id || 0) - Number(b.id || 0)
    })
  const anchors = (reopenAnchors || [])
    .map((value) => ({ value, ts: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts)

  const rows = []
  let pending = null
  let lastValidOutboundTs = 0

  const startPending = (msg, ts) => {
    const reopen = anchors
      .filter((item) => item.ts <= ts && item.ts > lastValidOutboundTs)
      .slice(-1)[0] || null
    pending = {
      firstInbound: msg,
      firstAutomation: null,
      tipoSla: reopen ? 'reabertura' : rows.length === 0 ? 'primeira_resposta' : 'nova_interacao',
      anchorEm: reopen?.value || msg.criado_em,
    }
  }

  const buildBase = () => ({
    ...base,
    ciclo_numero: rows.length + 1,
    tipo_sla: pending.tipoSla,
    primeira_mensagem_cliente_em: pending.firstInbound.criado_em,
    dia: formatSaoPauloDateKey(pending.firstInbound.criado_em),
    hora: saoPauloHourKey(pending.firstInbound.criado_em),
    dia_semana: saoPauloWeekdayIndex(pending.firstInbound.criado_em),
    limite_min: limiteMin,
    meta_origem: metaOrigem,
    meta_origem_label: metaOrigemLabel,
    anchor_em: pending.anchorEm,
  })

  for (const msg of sorted) {
    const ts = new Date(msg.criado_em).getTime()
    if (!Number.isFinite(ts)) continue

    if (msg.direcao === 'in') {
      if (!pending) {
        startPending(msg, ts)
      } else {
        const pendingTs = new Date(pending.firstInbound.criado_em).getTime()
        const reopenedAfterPending = anchors.some(
          (item) => item.ts > pendingTs && item.ts <= ts
        )
        // Uma reabertura inicia uma nova espera operacional. Isso evita que uma
        // mensagem antiga, nunca respondida antes do encerramento, contamine o
        // ciclo atual.
        if (reopenedAfterPending) startPending(msg, ts)
      }
      continue
    }

    const classification = classifyOutbound(msg, ctx)
    if (!pending) {
      if (classification.valida) lastValidOutboundTs = ts
      continue
    }
    if (!classification.valida) {
      if (!pending.firstAutomation) pending.firstAutomation = { msg, classification }
      continue
    }

    const rowBase = buildBase()
    const diffMin = calcDiffMinutes(pending.firstInbound.criado_em, msg.criado_em, schedule)
    if (diffMin == null || diffMin < 0) {
      rows.push({
        ...rowBase,
        primeira_resposta_em: msg.criado_em,
        tipo_resposta: classification.tipo || 'humana',
        origem_resposta: classification.origem || explicitMessageOrigin(msg),
        status_sla: 'dados_insuficientes',
        cumpriu_sla: null,
        tempo_resposta_min: null,
        motivo: 'Não foi possível calcular o tempo entre mensagens.',
      })
    } else {
      const cumpriu = diffMin <= limiteMin
      rows.push({
        ...rowBase,
        primeira_resposta_em: msg.criado_em,
        primeira_resposta_atendente_em: msg.criado_em,
        tipo_resposta: classification.tipo || 'humana',
        origem_resposta: classification.origem || explicitMessageOrigin(msg),
        status_sla: cumpriu ? 'cumpriu' : 'violou',
        cumpriu_sla: cumpriu,
        tempo_resposta_min: diffMin,
        motivo: cumpriu ? 'Resposta dentro da meta configurada.' : 'Resposta acima da meta configurada.',
      })
    }
    lastValidOutboundTs = ts
    pending = null
  }

  if (pending) {
    const rowBase = buildBase()
    const auto = pending.firstAutomation
    rows.push({
      ...rowBase,
      primeira_resposta_em: auto?.msg?.criado_em || null,
      tipo_resposta: auto?.classification?.tipo || null,
      origem_resposta: auto?.classification?.origem || (auto?.msg ? explicitMessageOrigin(auto.msg) : null),
      status_sla: 'sem_resposta',
      cumpriu_sla: null,
      tempo_resposta_min: null,
      motivo: auto
        ? 'Aguardando resposta humana; automação/bot não encerrou o prazo.'
        : 'Aguardando resposta humana.',
    })
  }

  return rows
}

async function fetchUsuariosNomeMap(company_id, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const map = {}
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  if (error) throw error
  for (const u of data || []) {
    if (u?.id != null) map[String(u.id)] = u?.nome || 'Sem nome'
  }
  return map
}

async function fetchDepartamentosNomeMap(company_id, depIds) {
  const ids = [...new Set((depIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const map = {}
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  if (error) throw error
  for (const d of data || []) {
    if (d?.id != null) map[String(d.id)] = d?.nome || 'Sem setor'
  }
  return map
}

async function fetchMensagensForConversas(company_id, conversaIds, instanceScope = null) {
  const ids = [...new Set((conversaIds || []).filter(Boolean))]
  if (ids.length === 0) return []
  const all = []
  for (const chunk of chunkArray(ids, 200)) {
    const rows = await fetchAllRows(() => {
      let query = supabase
        .from('mensagens')
        .select('id, conversa_id, criado_em, direcao, autor_usuario_id, texto, tipo, whatsapp_id, whatsapp_instance_id, origem, apagada_para_todos')
        .eq('company_id', company_id)
        .in('conversa_id', chunk)
        .in('direcao', ['in', 'out'])
        .order('criado_em', { ascending: true })
      if (instanceScope) query = applyDashboardInstanceScope(query, instanceScope)
      return query
    })
    all.push(...rows)
  }
  return dedupeOperationalMessages(all).rows
}

function buildGroupRanking(items, keyGetter, labelGetter) {
  const map = new Map()
  for (const item of items) {
    if (item.status_sla !== 'cumpriu' && item.status_sla !== 'violou') continue
    const key = keyGetter(item)
    const label = labelGetter(item)
    if (!map.has(key)) {
      map.set(key, { id: key, nome: label, total_analisadas: 0, dentro_sla: 0, fora_sla: 0, tempos: [] })
    }
    const row = map.get(key)
    row.total_analisadas += 1
    row.tempos.push(item.tempo_resposta_min)
    if (item.cumpriu_sla) row.dentro_sla += 1
    else row.fora_sla += 1
  }
  return Array.from(map.values())
    .map((row) => ({
      id: row.id,
      nome: row.nome,
      total_analisadas: row.total_analisadas,
      dentro_sla: row.dentro_sla,
      fora_sla: row.fora_sla,
      percentual_cumprido: percent(row.dentro_sla, row.total_analisadas),
      tempo_medio_primeira_resposta_min: round1(avg(row.tempos)),
    }))
}

function buildHourlyViolationRanking(violacoes) {
  const map = new Map()
  for (const v of violacoes) {
    const key = v.hora || 'Sem hora'
    if (!map.has(key)) map.set(key, { hora: key, violacoes: 0 })
    map.get(key).violacoes += 1
  }
  return Array.from(map.values()).sort((a, b) => b.violacoes - a.violacoes)
}

function buildWeekdayViolationRanking(violacoes) {
  const map = new Map()
  for (const v of violacoes) {
    const idx = v.dia_semana
    const key = idx != null ? idx : -1
    const label = idx != null ? WEEKDAY_NAMES[idx] : 'Sem dia'
    if (!map.has(key)) map.set(key, { dia_semana: key, dia_semana_nome: label, violacoes: 0, tempos: [] })
    const row = map.get(key)
    row.violacoes += 1
    if (Number.isFinite(v.tempo_resposta_min)) row.tempos.push(v.tempo_resposta_min)
  }
  return Array.from(map.values())
    .map((row) => ({
      ...row,
      tempo_medio_violacao_min: round1(avg(row.tempos)),
    }))
    .sort((a, b) => b.violacoes - a.violacoes)
}

function buildResumoFromAnalisadas(analisadas, extras = {}) {
  const totalAnalisadas = analisadas.length
  const dentroSla = analisadas.filter((x) => x.cumpriu_sla).length
  const foraSla = analisadas.filter((x) => x.cumpriu_sla === false).length
  const tempos = analisadas.map((x) => x.tempo_resposta_min).filter((v) => Number.isFinite(v))
  return {
    total_conversas_com_cliente: extras.total_conversas_com_cliente ?? totalAnalisadas + (extras.sem_resposta || 0) + (extras.dados_insuficientes || 0),
    total_analisadas: totalAnalisadas,
    dentro_sla: dentroSla,
    fora_sla: foraSla,
    sem_resposta: extras.sem_resposta || 0,
    dados_insuficientes: extras.dados_insuficientes || 0,
    resposta_humana: extras.resposta_humana || 0,
    resposta_automacao: extras.resposta_automacao || 0,
    reabertura_total: extras.reabertura_total || 0,
    percentual_cumprido: percent(dentroSla, totalAnalisadas),
    tempo_medio_primeira_resposta_min: round1(avg(tempos)),
    pior_tempo_resposta_min: tempos.length ? round1(Math.max(...tempos)) : null,
    melhor_tempo_resposta_min: tempos.length ? round1(Math.min(...tempos)) : null,
    ...extras,
  }
}

function summarizeResponseCycleTimes(rows = []) {
  const ordered = (rows || [])
    .slice()
    .sort((a, b) => (
      new Date(a.primeira_mensagem_cliente_em).getTime()
      - new Date(b.primeira_mensagem_cliente_em).getTime()
    ))
  const firstCycleByConversation = new Map()
  for (const row of ordered) {
    const key = row.cliente_id != null
      ? `cliente:${row.cliente_id}`
      : `conversa:${row.conversa_id}`
    if (!firstCycleByConversation.has(key)) firstCycleByConversation.set(key, row)
  }
  const firstCycles = Array.from(firstCycleByConversation.values())
  const responded = ordered.filter(
    (row) => (row.status_sla === 'cumpriu' || row.status_sla === 'violou')
      && Number.isFinite(row.tempo_resposta_min)
  )
  const firstResponded = firstCycles.filter(
    (row) => (row.status_sla === 'cumpriu' || row.status_sla === 'violou')
      && Number.isFinite(row.tempo_resposta_min)
  )
  return {
    responded,
    firstCycles,
    firstResponded,
    tempo_medio_resposta_min: round1(avg(responded.map((row) => row.tempo_resposta_min))),
    tempo_medio_primeira_resposta_min: round1(avg(firstResponded.map((row) => row.tempo_resposta_min))),
  }
}

function buildDiarioFromItems(items, semRespostaItems, dadosInsuficientesItems) {
  const porDiaMap = new Map()

  const touchDay = (key) => {
    if (!porDiaMap.has(key)) {
      porDiaMap.set(key, { dia: key, total_analisadas: 0, dentro_sla: 0, fora_sla: 0, sem_resposta: 0, dados_insuficientes: 0, tempos: [] })
    }
    return porDiaMap.get(key)
  }

  for (const item of items) {
    const row = touchDay(item.dia || 'Sem data')
    if (item.status_sla === 'cumpriu' || item.status_sla === 'violou') {
      row.total_analisadas += 1
      row.tempos.push(item.tempo_resposta_min)
      if (item.cumpriu_sla) row.dentro_sla += 1
      else row.fora_sla += 1
    }
  }
  for (const item of semRespostaItems) {
    touchDay(item.dia || 'Sem data').sem_resposta += 1
  }
  for (const item of dadosInsuficientesItems) {
    touchDay(item.dia || 'Sem data').dados_insuficientes += 1
  }

  return Array.from(porDiaMap.values())
    .map((row) => {
      const sorted = row.tempos.filter(Number.isFinite).slice().sort((a, b) => a - b)
      return {
        dia: row.dia,
        total_analisadas: row.total_analisadas,
        dentro_sla: row.dentro_sla,
        fora_sla: row.fora_sla,
        sem_resposta: row.sem_resposta,
        dados_insuficientes: row.dados_insuficientes,
        percentual_cumprido: percent(row.dentro_sla, row.total_analisadas),
        tempo_medio_resposta_min: round1(avg(row.tempos)),
        tempo_medio_primeira_resposta_min: round1(avg(row.tempos)),
        pior_tempo_resposta_min: sorted.length ? round1(sorted[sorted.length - 1]) : null,
        melhor_tempo_resposta_min: sorted.length ? round1(sorted[0]) : null,
      }
    })
    .sort((a, b) => a.dia.localeCompare(b.dia))
}

function pickBestWorstDay(diario, metaPercentual) {
  const withData = (diario || []).filter((d) => d.total_analisadas > 0)
  if (!withData.length) return { melhor_dia: null, pior_dia: null }
  const sorted = withData.slice().sort((a, b) => (b.percentual_cumprido || 0) - (a.percentual_cumprido || 0))
  return {
    melhor_dia: sorted[0],
    pior_dia: sorted[sorted.length - 1],
    dias_abaixo_meta: withData.filter((d) => d.percentual_cumprido != null && d.percentual_cumprido < metaPercentual),
  }
}

async function buildSlaAnalytics(company_id, query = {}, opts = {}) {
  const range = getDateRangeFromQuery(query)
  const diaFiltro = parseDateOnly(query.dia)?.value || null
  const atendenteId = toPositiveInt(query.atendente_id)
  const departamentoId = toPositiveInt(query.departamento_id)
  const statusAtendimento = String(query.status_atendimento || '').trim()
  const skipTrend = opts.skipTrend === true
  const instanceScope = opts.instanceScope || await resolveDashboardInstanceScope(company_id, query.whatsapp_instance_id)

  const [slaConfig, simpleMode] = await Promise.all([
    loadSlaConfig(company_id),
    loadSimpleModeOperator(company_id),
  ])
  const simpleOperator = simpleMode.operator
  const businessInfo = await loadSlaBusinessSchedule(company_id, slaConfig)
  const schedule = businessInfo.schedule
  const { triageMerged, absence } = await loadChatbotTriageMergeAndAbsence(company_id)
  const ctx = {
    triageMerged,
    absenceCfg: absence,
    contarBot: slaConfig.sla_contar_bot_como_resposta,
  }

  let conversasQuery = supabase
    .from('conversas')
    .select('id, cliente_id, telefone, status_atendimento, modo_simples_aguardando, tipo, criado_em, atendente_id, departamento_id, reaberta_falta_interacao_em, clientes!conversas_cliente_fk ( nome )')
    .eq('company_id', company_id)
  conversasQuery = applyDashboardInstanceScope(conversasQuery, instanceScope)

  if (atendenteId) {
    conversasQuery = simpleOperator && Number(simpleOperator.id) === atendenteId
      ? conversasQuery.or(`atendente_id.eq.${atendenteId},atendente_id.is.null`)
      : conversasQuery.eq('atendente_id', atendenteId)
  }
  if (departamentoId) conversasQuery = conversasQuery.eq('departamento_id', departamentoId)
  if (statusAtendimento) conversasQuery = conversasQuery.eq('status_atendimento', statusAtendimento)
  if (range.toIso) conversasQuery = conversasQuery.lte('criado_em', range.toIso)

  const { data: conversasRows, error: conversasError } = await conversasQuery
  if (conversasError) throw conversasError

  const conversas = (Array.isArray(conversasRows) ? conversasRows : [])
    .filter(isIndividualCustomerConversation)
  const conversaById = new Map(conversas.map((c) => [String(c.id), c]))
  const mensagens = await fetchMensagensForConversas(company_id, conversas.map((c) => c.id), instanceScope)
  const reaberturasPorConversa = new Map()
  if (conversas.length > 0) {
    const conversaIds = conversas.map((c) => c.id)
    for (const ids of chunkArray(conversaIds, 200)) {
      const rows = await fetchAllRows(() =>
        supabase
          .from('atendimentos')
          .select('id, conversa_id, criado_em, acao')
          .eq('company_id', company_id)
          .eq('acao', 'reabriu')
          .in('conversa_id', ids)
          .order('criado_em', { ascending: true })
      )
      for (const row of rows) {
        const key = String(row.conversa_id)
        if (!reaberturasPorConversa.has(key)) reaberturasPorConversa.set(key, [])
        reaberturasPorConversa.get(key).push(row.criado_em)
      }
    }
  }

  const usuarioNomeMap = await fetchUsuariosNomeMap(company_id, [
    ...conversas.map((c) => c?.atendente_id),
    simpleOperator?.id,
  ])
  const depNomeMap = await fetchDepartamentosNomeMap(company_id, conversas.map((c) => c?.departamento_id))

  const mensagensPorConversa = new Map()
  for (const msg of mensagens || []) {
    const key = String(msg.conversa_id)
    if (!mensagensPorConversa.has(key)) mensagensPorConversa.set(key, [])
    mensagensPorConversa.get(key).push(msg)
  }

  const primeiraRespostaRows = []
  const reaberturaRows = []
  const semResposta = []
  const dadosInsuficientes = []
  const allRows = []
  for (const [conversaId, msgs] of mensagensPorConversa.entries()) {
    const conversa = conversaById.get(String(conversaId))
    if (!conversa) continue
    msgs.sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime())

    const effectiveAtendenteId = conversa.atendente_id || simpleOperator?.id || null
    const meta = resolveMetaMinutos(slaConfig, {
      atendente_id: effectiveAtendenteId,
      departamento_id: conversa.departamento_id,
    })

    const atendenteNome = usuarioNomeMap[String(effectiveAtendenteId)] || simpleOperator?.nome || 'Sem atendente'
    const setorNome = conversa?.departamento_id != null
      ? (depNomeMap[String(conversa.departamento_id)] || 'Sem setor')
      : simpleMode.enabled
        ? 'Atendimento simples'
        : 'Sem setor'
    const base = {
      conversa_id: conversa.id,
      cliente_id: conversa.cliente_id || null,
      cliente_nome: getDisplayName(conversa.clientes) || conversa.telefone || 'Cliente',
      telefone: conversa.telefone || '',
      status_atendimento: conversa.status_atendimento || '',
      modo_simples_aguardando: conversa.modo_simples_aguardando || null,
      tipo_conversa: conversa.tipo || null,
      atendente_id: effectiveAtendenteId,
      atendente_nome: atendenteNome,
      departamento_id: conversa.departamento_id || null,
      setor: setorNome,
    }

    const reopenAnchors = [
      conversa.reaberta_falta_interacao_em,
      ...(reaberturasPorConversa.get(String(conversaId)) || []),
    ].filter(Boolean)
    const ciclos = analyzeConversationSlaCycles({
      msgs,
      reopenAnchors,
      limiteMin: meta.limite_min,
      metaOrigem: meta.meta_origem,
      metaOrigemLabel: meta.meta_origem_label,
      schedule,
      ctx,
      base,
    })

    for (const ciclo of ciclos) {
      const inboundTs = new Date(ciclo.primeira_mensagem_cliente_em).getTime()
      if (!Number.isFinite(inboundTs)) continue
      if (range.fromIso && inboundTs < new Date(range.fromIso).getTime()) continue
      if (range.toIso && inboundTs > new Date(range.toIso).getTime()) continue
      if (diaFiltro && ciclo.dia !== diaFiltro) continue

      allRows.push(ciclo)
      if (ciclo.tipo_sla === 'reabertura') reaberturaRows.push(ciclo)
      if (ciclo.status_sla === 'cumpriu' || ciclo.status_sla === 'violou') {
        primeiraRespostaRows.push(ciclo)
      } else if (ciclo.status_sla === 'sem_resposta') {
        semResposta.push(ciclo)
      } else if (ciclo.status_sla === 'dados_insuficientes') {
        dadosInsuficientes.push(ciclo)
      }
    }
  }

  const analisadas = primeiraRespostaRows
  const violacoes = analisadas.filter((x) => x.status_sla === 'violou')
  const respostaHumana = analisadas.filter((x) => x.tipo_resposta === 'humana').length
  const respostaAutomacao = allRows.filter((x) => x.tipo_resposta === 'automacao').length
  const responseTimeSummary = summarizeResponseCycleTimes(allRows)

  const now = Date.now()
  const criticasSemResposta = semResposta
    .filter((x) => (
      simpleMode.enabled
        ? x.modo_simples_aguardando === 'atendente'
        : OPEN_STATUSES.has(x.status_atendimento)
    ))
    .map((x) => {
      const minAguardando = calcDiffMinutes(
        x.primeira_mensagem_cliente_em,
        new Date(now).toISOString(),
        schedule
      )
      const limite = x.limite_min || slaConfig.sla_minutos_sem_resposta
      return {
        ...x,
        minutos_aguardando: Number.isFinite(minAguardando) ? minAguardando : 0,
        critica: Number.isFinite(minAguardando) && minAguardando >= limite,
      }
    })
    .filter((x) => x.critica)
    .sort((a, b) => b.minutos_aguardando - a.minutos_aguardando)
    .slice(0, 100)

  const resumo = buildResumoFromAnalisadas(analisadas, {
    sem_resposta: semResposta.length,
    dados_insuficientes: dadosInsuficientes.length,
    resposta_humana: respostaHumana,
    resposta_automacao: respostaAutomacao,
    reabertura_total: reaberturaRows.filter((x) => x.status_sla === 'cumpriu' || x.status_sla === 'violou').length,
    total_ciclos_com_cliente: allRows.length,
    total_conversas_com_cliente: new Set(allRows.map((item) => String(item.conversa_id))).size,
    total_primeiras_respostas_analisadas: responseTimeSummary.firstResponded.length,
    tempo_medio_resposta_min: responseTimeSummary.tempo_medio_resposta_min,
    tempo_medio_primeira_resposta_min: responseTimeSummary.tempo_medio_primeira_resposta_min,
    meta_minutos_global: slaConfig.sla_minutos_sem_resposta,
    meta_percentual_configurada: slaConfig.sla_meta_percentual,
  })

  const diario = buildDiarioFromItems(analisadas, semResposta, dadosInsuficientes)
  const diaStats = pickBestWorstDay(diario, slaConfig.sla_meta_percentual)

  const rankingAtendentes = buildGroupRanking(
    analisadas,
    (item) => item.atendente_id || 'sem-atendente',
    (item) => item.atendente_nome || 'Sem atendente'
  )
  const rankingSetores = buildGroupRanking(
    analisadas,
    (item) => item.departamento_id || 'sem-setor',
    (item) => item.setor || 'Sem setor'
  )

  let tendencia = null
  if (!skipTrend && !diaFiltro) {
    const prevRange = getPreviousPeriodRange(range)
    if (prevRange) {
      const prev = await buildSlaAnalytics(company_id, {
        ...query,
        data_inicio: prevRange.data_inicio,
        data_fim: prevRange.data_fim,
      }, { skipTrend: true, instanceScope })
      const atualPct = resumo.percentual_cumprido
      const prevPct = prev?.resumo?.percentual_cumprido
      tendencia = {
        periodo_anterior: prevRange,
        percentual_anterior: prevPct,
        variacao_percentual: atualPct != null && prevPct != null ? round1(atualPct - prevPct) : null,
        direcao: atualPct != null && prevPct != null ? (atualPct > prevPct ? 'subiu' : atualPct < prevPct ? 'caiu' : 'estavel') : null,
      }
    }
  }

  const conversasDetalhadas = allRows
    .slice()
    .sort((a, b) => new Date(b.primeira_mensagem_cliente_em).getTime() - new Date(a.primeira_mensagem_cliente_em).getTime())
  const primeirasDoPeriodo = responseTimeSummary.firstCycles
  const primeirasRespondidas = responseTimeSummary.firstResponded

  return {
    periodo: range,
    instancia: instanceScope,
    dia_filtro: diaFiltro,
    limite_min: slaConfig.sla_minutos_sem_resposta,
    meta_percentual: slaConfig.sla_meta_percentual,
    config: {
      sla_minutos_sem_resposta: slaConfig.sla_minutos_sem_resposta,
      sla_meta_percentual: slaConfig.sla_meta_percentual,
      sla_usar_horario_comercial: slaConfig.sla_usar_horario_comercial,
      sla_contar_bot_como_resposta: slaConfig.sla_contar_bot_como_resposta,
      metas_departamentos: slaConfig.metas_departamentos,
      metas_usuarios: slaConfig.metas_usuarios,
    },
    horario_comercial: businessInfo,
    resumo,
    tendencia,
    por_tipo: {
      primeira_resposta: {
        analisadas: primeirasRespondidas.length,
        dentro_sla: primeirasRespondidas.filter((item) => item.status_sla === 'cumpriu').length,
        fora_sla: primeirasRespondidas.filter((item) => item.status_sla === 'violou').length,
        sem_resposta: primeirasDoPeriodo.filter((item) => item.status_sla === 'sem_resposta').length,
        dados_insuficientes: primeirasDoPeriodo.filter((item) => item.status_sla === 'dados_insuficientes').length,
        tempo_medio_min: responseTimeSummary.tempo_medio_primeira_resposta_min,
      },
      ciclos_resposta: {
        total: allRows.length,
        respondidos: analisadas.length,
        dentro_sla: resumo.dentro_sla,
        fora_sla: resumo.fora_sla,
        sem_resposta: semResposta.length,
        dados_insuficientes: dadosInsuficientes.length,
      },
      reabertura: {
        total: reaberturaRows.length,
        dentro_sla: reaberturaRows.filter((x) => x.status_sla === 'cumpriu').length,
        fora_sla: reaberturaRows.filter((x) => x.status_sla === 'violou').length,
        sem_resposta: reaberturaRows.filter((x) => x.status_sla === 'sem_resposta').length,
        dados_insuficientes: reaberturaRows.filter((x) => x.status_sla === 'dados_insuficientes').length,
        itens: reaberturaRows.slice(0, 200),
      },
      resposta_humana: respostaHumana,
      resposta_automacao: respostaAutomacao,
    },
    ranking_atendentes: rankingAtendentes,
    ranking_atendentes_melhor: rankingAtendentes.slice().sort((a, b) => (b.percentual_cumprido || 0) - (a.percentual_cumprido || 0)).slice(0, 10),
    ranking_atendentes_violacoes: rankingAtendentes.slice().sort((a, b) => b.fora_sla - a.fora_sla || (a.percentual_cumprido || 0) - (b.percentual_cumprido || 0)).slice(0, 10),
    ranking_setores: rankingSetores,
    horarios_maior_violacao: buildHourlyViolationRanking(violacoes).slice(0, 12),
    dias_semana_pior_sla: buildWeekdayViolationRanking(violacoes),
    violacoes: violacoes.sort((a, b) => b.tempo_resposta_min - a.tempo_resposta_min).slice(0, 500),
    sem_resposta: semResposta.slice(0, 500),
    dados_insuficientes: dadosInsuficientes.slice(0, 500),
    criticas_sem_resposta: criticasSemResposta,
    conversas_detalhadas: conversasDetalhadas.slice(0, 500),
    diario,
    melhor_dia: diaStats.melhor_dia,
    pior_dia: diaStats.pior_dia,
    dias_abaixo_meta: diaStats.dias_abaixo_meta || [],
    reabertura: reaberturaRows.slice(0, 200),
  }
}

async function validateConversaSla(company_id, conversaId) {
  const id = Number(conversaId)
  if (!Number.isFinite(id) || id <= 0) return { error: 'conversa_id inválido' }

  const instanceScope = await resolveDashboardInstanceScope(company_id)
  let conversaQuery = supabase
    .from('conversas')
    .select('id, cliente_id, telefone, status_atendimento, modo_simples_aguardando, tipo, criado_em, atendente_id, departamento_id, reaberta_falta_interacao_em, clientes!conversas_cliente_fk ( nome )')
    .eq('company_id', company_id)
    .eq('id', id)
  conversaQuery = applyDashboardInstanceScope(conversaQuery, instanceScope)
  const { data: conversa, error } = await conversaQuery.maybeSingle()
  if (error) throw error
  if (!conversa) return { error: 'Conversa não encontrada' }

  const [slaConfig, simpleMode] = await Promise.all([
    loadSlaConfig(company_id),
    loadSimpleModeOperator(company_id),
  ])
  const simpleOperator = simpleMode.operator
  const businessInfo = await loadSlaBusinessSchedule(company_id, slaConfig)
  const { triageMerged, absence } = await loadChatbotTriageMergeAndAbsence(company_id)
  const ctx = { triageMerged, absenceCfg: absence, contarBot: slaConfig.sla_contar_bot_como_resposta }

  const msgs = await fetchMensagensForConversas(company_id, [id], instanceScope)
  msgs.sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime())

  const effectiveAtendenteId = conversa.atendente_id || simpleOperator?.id || null
  const meta = resolveMetaMinutos(slaConfig, {
    atendente_id: effectiveAtendenteId,
    departamento_id: conversa.departamento_id,
  })

  const base = {
    conversa_id: conversa.id,
    cliente_id: conversa.cliente_id || null,
    cliente_nome: getDisplayName(conversa.clientes) || conversa.telefone || 'Cliente',
    telefone: conversa.telefone || '',
    status_atendimento: conversa.status_atendimento || '',
    modo_simples_aguardando: conversa.modo_simples_aguardando || null,
    tipo_conversa: conversa.tipo || null,
    atendente_id: effectiveAtendenteId,
    atendente_nome: simpleOperator?.nome || 'Sem atendente',
  }

  const { data: reopenRows, error: reopenError } = await supabase
    .from('atendimentos')
    .select('criado_em')
    .eq('company_id', company_id)
    .eq('conversa_id', id)
    .eq('acao', 'reabriu')
    .order('criado_em', { ascending: true })
  if (reopenError) throw reopenError
  const ciclos = analyzeConversationSlaCycles({
    msgs,
    reopenAnchors: [
      conversa.reaberta_falta_interacao_em,
      ...(reopenRows || []).map((row) => row.criado_em),
    ].filter(Boolean),
    limiteMin: meta.limite_min,
    metaOrigem: meta.meta_origem,
    metaOrigemLabel: meta.meta_origem_label,
    schedule: businessInfo.schedule,
    ctx,
    base,
  })
  const resultado = ciclos[ciclos.length - 1] || null

  const passos = []
  const primeiraIn = resultado
    ? msgs.find((msg) => msg.direcao === 'in' && msg.criado_em === resultado.primeira_mensagem_cliente_em)
    : null
  if (primeiraIn) {
    passos.push({ passo: 1, descricao: 'Início do ciclo mais recente: mensagem do cliente', em: primeiraIn.criado_em, mensagem_id: primeiraIn.id })
    const outValida = resultado.primeira_resposta_atendente_em
      ? msgs.find((msg) => msg.direcao === 'out' && msg.criado_em === resultado.primeira_resposta_atendente_em)
      : null
    const outQualquer = findFirstAnyOutboundAfter(msgs, new Date(primeiraIn.criado_em).getTime())
    if (outValida) {
      passos.push({ passo: 2, descricao: 'Primeira resposta humana válida', em: outValida.criado_em, mensagem_id: outValida.id, autor_usuario_id: outValida.autor_usuario_id })
    } else if (outQualquer) {
      passos.push({ passo: 2, descricao: 'Primeira resposta detectada (automação/bot — não conta)', em: outQualquer.criado_em, mensagem_id: outQualquer.id, autor_usuario_id: outQualquer.autor_usuario_id })
    } else {
      passos.push({ passo: 2, descricao: 'Sem resposta outbound após a primeira mensagem do cliente', em: null })
    }
    if (resultado?.tempo_resposta_min != null) {
      passos.push({
        passo: 3,
        descricao: 'Tempo calculado',
        minutos: resultado.tempo_resposta_min,
        modo: businessInfo.modo_contagem,
        limite_min: meta.limite_min,
        meta_origem: meta.meta_origem_label,
        status_sla: resultado.status_sla,
      })
    }
  } else {
    passos.push({ passo: 1, descricao: 'Nenhum ciclo inbound encontrado', em: null })
  }

  return {
    conversa_id: id,
    resultado,
    ciclos: ciclos.slice(-50),
    passos_validacao: passos,
    horario_comercial: businessInfo,
    config: {
      limite_min: meta.limite_min,
      meta_origem: meta.meta_origem,
      meta_origem_label: meta.meta_origem_label,
      sla_contar_bot_como_resposta: slaConfig.sla_contar_bot_como_resposta,
    },
  }
}

async function saveSlaConfig(company_id, body = {}) {
  const update = {
    // Mantém o banco coerente com a regra obrigatória usada pelo motor.
    sla_usar_horario_comercial: true,
  }
  if (body.sla_minutos_sem_resposta != null) {
    update.sla_minutos_sem_resposta = normalizeMinutes(body.sla_minutos_sem_resposta, 30)
  }
  if (body.sla_meta_percentual != null) {
    update.sla_meta_percentual = clampInt(body.sla_meta_percentual, 1, 100) ?? 90
  }
  if (body.sla_contar_bot_como_resposta != null) {
    update.sla_contar_bot_como_resposta = body.sla_contar_bot_como_resposta === true
  }

  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from('empresas').update(update).eq('id', company_id)
    if (error) throw error
  }

  if (Array.isArray(body.metas_departamentos)) {
    for (const item of body.metas_departamentos) {
      const depId = Number(item?.departamento_id ?? item?.id)
      if (!Number.isFinite(depId) || depId <= 0) continue
      const val = item.sla_minutos_sem_resposta
      const { error } = await supabase
        .from('departamentos')
        .update({ sla_minutos_sem_resposta: val == null || val === '' ? null : normalizeMinutes(val) })
        .eq('company_id', company_id)
        .eq('id', depId)
      if (error) throw error
    }
  }

  if (Array.isArray(body.metas_usuarios)) {
    for (const item of body.metas_usuarios) {
      const userId = Number(item?.usuario_id ?? item?.id)
      if (!Number.isFinite(userId) || userId <= 0) continue
      const val = item.sla_minutos_sem_resposta
      const { error } = await supabase
        .from('usuarios')
        .update({ sla_minutos_sem_resposta: val == null || val === '' ? null : normalizeMinutes(val) })
        .eq('company_id', company_id)
        .eq('id', userId)
      if (error) throw error
    }
  }

  return loadSlaConfig(company_id)
}

function flattenSlaExportRows(data) {
  const rows = []
  for (const item of data.conversas_detalhadas || []) {
    rows.push({
      tipo_sla: item.tipo_sla,
      status_sla: item.status_sla,
      cliente: item.cliente_nome,
      telefone: item.telefone,
      atendente: item.atendente_nome,
      setor: item.setor,
      primeira_msg_cliente: item.primeira_mensagem_cliente_em,
      primeira_resposta: item.primeira_resposta_em || item.primeira_resposta_atendente_em || '',
      tempo_min: item.tempo_resposta_min ?? '',
      limite_min: item.limite_min,
      meta_origem: item.meta_origem_label || item.meta_origem,
      tipo_resposta: item.tipo_resposta || '',
      origem_resposta: item.origem_resposta || '',
      status_conversa: item.status_atendimento,
      conversa_id: item.conversa_id,
    })
  }
  return rows
}

module.exports = {
  SAO_PAULO_TZ,
  SLA_BUSINESS_START_MINUTE,
  SLA_BUSINESS_END_MINUTE,
  loadSlaConfig,
  saveSlaConfig,
  resolveMetaMinutos,
  loadSlaBusinessSchedule,
  buildSlaAnalytics,
  validateConversaSla,
  flattenSlaExportRows,
  getDateRangeFromQuery,
  formatSaoPauloDateKey,
  calcDiffMinutes,
  analyzeSlaCycle,
  analyzeConversationSlaCycles,
  summarizeResponseCycleTimes,
  classifyOutbound,
}
