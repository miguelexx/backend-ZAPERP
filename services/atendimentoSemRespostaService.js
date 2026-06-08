const supabase = require('../config/supabase')
const { getProvider } = require('./providers')

const DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG = {
  alerta_sem_resposta_ativo: false,
  tempo_primeiro_alerta_minutos: 2,
  tempo_alerta_critico_minutos: 10,
  tempo_notificar_gestor_minutos: 15,
  notificar_por_whatsapp: false,
  notificar_por_email: false,
  notificar_interno: true,
  reabrir_conversa_automaticamente: true,
  aplicar_tag_automatica: true,
  nome_tag_automatica: 'Reaberta por falta de resposta',
  gestor_notificado_id: null,
  responsaveis_notificacao_ids: [],
  telefone_gestor: '',
  horario_comercial_ativo: false,
  timezone: 'America/Sao_Paulo',
}

const EVENT_TYPES = {
  FIRST: 'primeiro_alerta',
  CRITICAL: 'alerta_critico',
  MANAGER: 'gestor_notificado',
  TAG: 'tag_aplicada',
  REOPEN: 'conversa_reaberta',
  RESET: 'sla_resetado',
  WHATSAPP_FAILED: 'whatsapp_falha',
  EMAIL_UNAVAILABLE: 'email_indisponivel',
}

const EMAIL_UNAVAILABLE_MESSAGE = 'Notificacao por e-mail ainda nao esta configurada no servidor.'

function coerceBoolean(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on', 'sim'].includes(value.trim().toLowerCase())
  return false
}

function coerceMinutes(value, fallback, min = 1, max = 10080) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function normalizeId(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function normalizeResponsibleIds(raw) {
  const values = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  return [...new Set(values.map(normalizeId).filter(Boolean))]
}

function normalizeAlertaSemRespostaConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const first = coerceMinutes(r.tempo_primeiro_alerta_minutos, DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.tempo_primeiro_alerta_minutos)
  const critical = coerceMinutes(r.tempo_alerta_critico_minutos, Math.max(10, first + 1))
  const manager = coerceMinutes(r.tempo_notificar_gestor_minutos, Math.max(15, critical + 1))
  const responsaveis = normalizeResponsibleIds(r.responsaveis_notificacao_ids || r.gestores_notificados_ids)
  const gestorId = normalizeId(r.gestor_notificado_id)

  return {
    alerta_sem_resposta_ativo: coerceBoolean(r.alerta_sem_resposta_ativo ?? r.ativo),
    tempo_primeiro_alerta_minutos: first,
    tempo_alerta_critico_minutos: Math.max(first + 1, critical),
    tempo_notificar_gestor_minutos: Math.max(Math.max(first + 1, critical) + 1, manager),
    notificar_por_whatsapp: coerceBoolean(r.notificar_por_whatsapp),
    notificar_por_email: coerceBoolean(r.notificar_por_email),
    notificar_interno: r.notificar_interno === undefined ? true : coerceBoolean(r.notificar_interno),
    reabrir_conversa_automaticamente: r.reabrir_conversa_automaticamente === undefined ? true : coerceBoolean(r.reabrir_conversa_automaticamente),
    aplicar_tag_automatica: r.aplicar_tag_automatica === undefined ? true : coerceBoolean(r.aplicar_tag_automatica),
    nome_tag_automatica: String(r.nome_tag_automatica || DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.nome_tag_automatica).trim().slice(0, 80) || DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.nome_tag_automatica,
    gestor_notificado_id: gestorId,
    responsaveis_notificacao_ids: gestorId ? [...new Set([gestorId, ...responsaveis])] : responsaveis,
    telefone_gestor: String(r.telefone_gestor || r.telefone_admin || '').trim().slice(0, 40),
    horario_comercial_ativo: coerceBoolean(r.horario_comercial_ativo),
    timezone: String(r.timezone || DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.timezone).trim().slice(0, 80) || DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.timezone,
  }
}

function validationError(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

function validateAlertaSemRespostaConfigInput(raw = {}) {
  const cfg = normalizeAlertaSemRespostaConfig(raw || {})
  if (coerceBoolean(raw?.notificar_por_email)) {
    throw validationError(EMAIL_UNAVAILABLE_MESSAGE)
  }
  if (cfg.tempo_alerta_critico_minutos <= cfg.tempo_primeiro_alerta_minutos) {
    throw validationError('O alerta critico precisa ser maior que o primeiro alerta.')
  }
  if (cfg.tempo_notificar_gestor_minutos <= cfg.tempo_alerta_critico_minutos) {
    throw validationError('A notificacao ao gestor precisa ser maior que o alerta critico.')
  }
  if (cfg.notificar_por_whatsapp && !cfg.telefone_gestor) {
    throw validationError('Para WhatsApp, informe o telefone do gestor.')
  }
  if (!cfg.notificar_por_whatsapp && !cfg.notificar_interno) {
    throw validationError('Selecione ao menos um canal de notificacao disponivel.')
  }
  return cfg
}

function parseIaConfigJson(config) {
  if (config == null) return {}
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof config === 'object' ? config : {}
}

async function getAlertaSemRespostaConfig(company_id) {
  const { data, error } = await supabase.from('ia_config').select('config').eq('company_id', Number(company_id)).maybeSingle()
  if (error) throw error
  const fullConfig = parseIaConfigJson(data?.config)
  return {
    fullConfig,
    config: normalizeAlertaSemRespostaConfig(fullConfig.alerta_sem_resposta || fullConfig.alerta_atendimento_sem_resposta || {}),
  }
}

async function saveAlertaSemRespostaConfig(company_id, input) {
  const { fullConfig } = await getAlertaSemRespostaConfig(company_id).catch(() => ({ fullConfig: {} }))
  const normalized = validateAlertaSemRespostaConfigInput(input || {})
  const nextConfig = { ...fullConfig, alerta_sem_resposta: normalized }
  const { error } = await supabase.from('ia_config').upsert({
    company_id: Number(company_id),
    config: nextConfig,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
  return normalized
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'America/Sao_Paulo',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  let hour = Number(get('hour'))
  if (hour === 24) hour = 0
  return {
    weekday: get('weekday'),
    minutes: hour * 60 + Number(get('minute') || 0),
  }
}

function hmToMinutes(value, fallback) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return fallback
  return Math.max(0, Math.min(23, Number(m[1]))) * 60 + Math.max(0, Math.min(59, Number(m[2])))
}

async function isWithinBusinessHours(company_id, cfg, now = new Date()) {
  if (!cfg.horario_comercial_ativo) return true
  const { data: emp } = await supabase.from('empresas').select('horario_inicio, horario_fim').eq('id', Number(company_id)).maybeSingle()
  const start = hmToMinutes(emp?.horario_inicio, 9 * 60)
  const end = hmToMinutes(emp?.horario_fim, 18 * 60)
  const z = zonedParts(now, cfg.timezone)
  if (['Sat', 'Sun'].includes(z.weekday)) return false
  if (start <= end) return z.minutes >= start && z.minutes <= end
  return z.minutes >= start || z.minutes <= end
}

async function registrarMensagemClienteSemResposta({ company_id, conversa_id, criado_em }) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!cid || !convId) return { ok: false, reason: 'invalid_context' }
  const ts = criado_em || new Date().toISOString()
  const { error } = await supabase
    .from('conversas')
    .update({
      ultima_mensagem_cliente_em: ts,
      sla_status: 'normal',
      primeiro_alerta_enviado_em: null,
      alerta_critico_enviado_em: null,
      gestor_notificado_em: null,
      conversa_reaberta_por_sla_em: null,
      motivo_reabertura: null,
      tag_aplicada_por_sla: false,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .not('status_atendimento', 'in', '("fechada","finalizada")')
  if (error) {
    console.warn('[alertaSemResposta] registrarMensagemCliente falhou:', error.message)
    return { ok: false, reason: 'db_error', error: error.message }
  }
  return { ok: true }
}

async function registrarRespostaAtendenteSemResposta({ company_id, conversa_id, criado_em }) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!cid || !convId) return { ok: false, reason: 'invalid_context' }
  const ts = criado_em || new Date().toISOString()
  const { data: conv } = await supabase
    .from('conversas')
    .select('primeiro_alerta_enviado_em, alerta_critico_enviado_em, gestor_notificado_em, sla_status')
    .eq('company_id', cid)
    .eq('id', convId)
    .not('status_atendimento', 'in', '("fechada","finalizada")')
    .maybeSingle()
  const hadActiveSla = Boolean(
    conv?.primeiro_alerta_enviado_em ||
    conv?.alerta_critico_enviado_em ||
    conv?.gestor_notificado_em ||
    (conv?.sla_status && conv.sla_status !== 'normal')
  )
  const { error: updateError } = await supabase
    .from('conversas')
    .update({
      ultima_resposta_atendente_em: ts,
      sla_status: 'normal',
      primeiro_alerta_enviado_em: null,
      alerta_critico_enviado_em: null,
      gestor_notificado_em: null,
      conversa_reaberta_por_sla_em: null,
      motivo_reabertura: null,
      tag_aplicada_por_sla: false,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .not('status_atendimento', 'in', '("fechada","finalizada")')
  if (updateError) {
    console.warn('[alertaSemResposta] registrarRespostaAtendente falhou:', updateError.message)
    return { ok: false, reason: 'db_error', error: updateError.message }
  }
  if (hadActiveSla) {
    await insertHistory(convId, null, EVENT_TYPES.RESET, 'Sistema: atendente respondeu e o fluxo de alerta foi encerrado.')
    await insertEvent({
      company_id: cid,
      conversa_id: convId,
      tipo: EVENT_TYPES.RESET,
      nivel: 'reset',
      mensagem: 'Fluxo de alerta encerrado apos resposta do atendente.',
      detalhes: { sla_status_anterior: conv?.sla_status || null },
    })
  }
  return { ok: true }
}

async function getLastMessage(company_id, conversa_id) {
  const { data } = await supabase
    .from('mensagens')
    .select('id, direcao, criado_em, autor_usuario_id, texto')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

function minutesSince(ts, now = Date.now()) {
  const t = new Date(ts || 0).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 60000))
}

async function fetchAttendantName(company_id, usuario_id) {
  const uid = normalizeId(usuario_id)
  if (!uid) return 'Atendente'
  const { data } = await supabase.from('usuarios').select('id, nome').eq('company_id', Number(company_id)).eq('id', uid).maybeSingle()
  return String(data?.nome || `Atendente ${uid}`).trim()
}

async function insertEvent(payload) {
  const { error } = await supabase.from('alerta_sem_resposta_eventos').insert(payload)
  if (!error) return true
  if (String(error.code || '') === '23505') return false
  if (String(error.code || '') !== '42P01') console.warn('[alertaSemResposta] evento:', error.message || error)
  return false
}

async function insertHistory(conversa_id, usuario_id, acao, observacao) {
  await supabase.from('historico_atendimentos').insert({
    conversa_id,
    usuario_id: usuario_id || null,
    acao,
    observacao,
  })
}

function emitInternal(io, company_id, usuario_id, payload) {
  if (!io || !payload) return
  if (usuario_id) io.to(`usuario_${usuario_id}`).emit('alerta_sem_resposta', payload)
  io.to(`empresa_${company_id}`).emit('alerta_sem_resposta_evento', payload)
}

async function recordAndNotify({ io, company_id, conv, tipo, nivel, minutos, mensagem, gestor_id = null, cfg, detalhes = {} }) {
  const eventPayload = {
    company_id,
    conversa_id: conv.id,
    atendente_id: conv.atendente_id || conv.atendente_original_id || null,
    gestor_id,
    tipo,
    nivel,
    minutos_sem_resposta: minutos,
    ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
    mensagem,
    detalhes: { status_atendimento: conv.status_atendimento, ...detalhes },
  }
  const inserted = await insertEvent(eventPayload)
  if (!inserted) return false

  if (cfg.notificar_interno) {
    emitInternal(io, company_id, conv.atendente_id, {
      ...eventPayload,
      id: undefined,
      titulo: nivel === 'critico' ? 'Alerta critico' : 'Atencao',
    })
  }
  return true
}

async function resolveManagerIds(company_id, cfg) {
  if (cfg.responsaveis_notificacao_ids.length) {
    const requested = cfg.responsaveis_notificacao_ids.map(Number).filter(Boolean)
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, perfil')
      .eq('company_id', Number(company_id))
      .in('id', requested)
    if (error) {
      console.warn('[alertaSemResposta] validar gestores:', error.message || error)
      return []
    }
    const allowed = new Set(['admin', 'gestor', 'supervisor'])
    const valid = new Set((data || [])
      .filter((u) => allowed.has(String(u.perfil || '').toLowerCase()))
      .map((u) => Number(u.id)))
    return requested.filter((id) => valid.has(id))
  }
  const { data } = await supabase
    .from('usuarios')
    .select('id, perfil')
    .eq('company_id', Number(company_id))
    .in('perfil', ['admin', 'gestor', 'supervisor'])
    .limit(20)
  return (data || []).map((u) => Number(u.id)).filter(Boolean)
}

function buildConversationUrl(conversaId) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '')
  if (!base || !conversaId) return ''
  return `${base}/atendimento?conversa=${encodeURIComponent(conversaId)}`
}

function buildManagerMessage({ company_id, conv, cfg, minutos, clienteNome, atendenteNome }) {
  const actionStatus = cfg.reabrir_conversa_automaticamente
    ? 'conversa reaberta por falta de resposta'
    : 'gestor notificado; conversa permanece com o atendente'
  const actionLine = cfg.reabrir_conversa_automaticamente
    ? 'A conversa foi liberada para outro atendente ou gestor assumir.'
    : 'A conversa permanece atribuida ao atendente atual para acompanhamento do gestor.'
  const conversaUrl = buildConversationUrl(conv.id)
  return [
    '🚨 Atendimento sem resposta no ZapERP',
    '',
    `Empresa: ${company_id}`,
    `Cliente: ${clienteNome || conv.nome_contato_cache || conv.telefone || conv.cliente_id || conv.id}`,
    `Atendente: ${atendenteNome}`,
    `Tempo sem resposta: ${minutos} minutos`,
    `Status: ${actionStatus}`,
    '',
    actionLine,
    ...(conversaUrl ? [`Abrir conversa: ${conversaUrl}`] : []),
  ].join('\n')
}

async function notifyManagersInternal({ io, company_id, conv, managerIds, gestorId, minutos, texto }) {
  for (const managerId of managerIds) {
    emitInternal(io, company_id, managerId, {
      company_id,
      conversa_id: conv.id,
      atendente_id: conv.atendente_id || null,
      gestor_id: gestorId || managerId,
      tipo: EVENT_TYPES.MANAGER,
      nivel: 'gestor',
      minutos_sem_resposta: minutos,
      mensagem: texto,
    })
  }
}

async function sendManagerWhatsApp({ company_id, conv, cfg, texto }) {
  if (!cfg.notificar_por_whatsapp) return { ok: true, skipped: true }
  if (!cfg.telefone_gestor) return { ok: false, error: 'telefone_gestor_ausente' }
  const provider = getProvider()
  if (!provider?.sendText) return { ok: false, error: 'provider_sendText_indisponivel' }
  try {
    const result = await provider.sendText(cfg.telefone_gestor, texto, {
      companyId: company_id,
      conversaId: conv.id,
      sendOrigin: 'alerta_sem_resposta_gestor',
    })
    if (result && result.ok === false) {
      return { ok: false, error: result.error || result.message || 'provider_sendText_falhou' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function notifyManagers({ io, company_id, conv, cfg, minutos, clienteNome, atendenteNome }) {
  const managerIds = await resolveManagerIds(company_id, cfg)
  const gestorId = managerIds[0] || null
  const texto = buildManagerMessage({ company_id, conv, cfg, minutos, clienteNome, atendenteNome })
  return { managerIds, gestorId, texto }
}

async function ensureAutomaticTag(company_id, name) {
  const nome = String(name || DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG.nome_tag_automatica).trim()
  const { data: existing } = await supabase.from('tags').select('id').eq('company_id', company_id).eq('nome', nome).maybeSingle()
  if (existing?.id) return existing.id
  const { data, error } = await supabase.from('tags').insert({ company_id, nome, cor: '#ef4444' }).select('id').single()
  if (error) {
    console.warn('[alertaSemResposta] criar tag:', error.message || error)
    return null
  }
  return data?.id || null
}

async function applyAutomaticTag(company_id, conversa_id, cfg, conv) {
  if (!cfg.aplicar_tag_automatica || conv.tag_aplicada_por_sla) return false
  const tagId = await ensureAutomaticTag(company_id, cfg.nome_tag_automatica)
  if (!tagId) return false
  const { data: existing } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('tag_id', tagId)
    .maybeSingle()
  if (!existing?.id) {
    await supabase.from('conversa_tags').insert({ company_id, conversa_id, tag_id: tagId })
  }
  await supabase.from('conversas').update({ tag_aplicada_por_sla: true }).eq('company_id', company_id).eq('id', conversa_id)
  await insertEvent({
    company_id,
    conversa_id,
    atendente_id: conv.atendente_id || conv.atendente_original_id || null,
    tipo: EVENT_TYPES.TAG,
    nivel: 'tag',
    minutos_sem_resposta: minutesSince(conv.ultima_mensagem_cliente_em),
    ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
    mensagem: `Tag automatica aplicada: ${cfg.nome_tag_automatica}`,
    detalhes: { tag_id: tagId, nome_tag: cfg.nome_tag_automatica },
  })
  await insertHistory(conversa_id, null, EVENT_TYPES.TAG, `Sistema aplicou a tag "${cfg.nome_tag_automatica}".`)
  return true
}

async function reopenConversation(company_id, conv, minutos) {
  if (conv.conversa_reaberta_por_sla_em) return false
  const nowIso = new Date().toISOString()
  const { data: locked, error } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'aberta',
      atendente_original_id: conv.atendente_original_id || conv.atendente_id || null,
      atendente_id: null,
      atendente_atribuido_em: null,
      sla_status: 'reaberta_por_falta_de_resposta',
      conversa_reaberta_por_sla_em: nowIso,
      motivo_reabertura: 'falta_de_resposta_atendente',
    })
    .eq('company_id', company_id)
    .eq('id', conv.id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)
    .is('conversa_reaberta_por_sla_em', null)
    .select('id')
    .maybeSingle()
  if (error) {
    console.warn('[alertaSemResposta] reabrir:', error.message || error)
    return false
  }
  if (!locked?.id) return false
  await insertEvent({
    company_id,
    conversa_id: conv.id,
    atendente_id: conv.atendente_id || conv.atendente_original_id || null,
    tipo: EVENT_TYPES.REOPEN,
    nivel: 'reaberta',
    minutos_sem_resposta: minutos,
    ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
    mensagem: 'Conversa liberada automaticamente por falta de resposta do atendente.',
    detalhes: { motivo_reabertura: 'falta_de_resposta_atendente' },
  })
  await insertHistory(conv.id, null, EVENT_TYPES.REOPEN, `Sistema liberou a conversa para outro atendente assumir apos ${minutos} minutos sem resposta.`)
  return true
}

async function fetchEligibleConversations(company_id, cfg) {
  const scanLimit = Math.max(50, Math.min(2000, Number(process.env.ALERTA_SEM_RESPOSTA_SCAN_LIMIT) || 500))
  const cutoff = new Date(Date.now() - cfg.tempo_primeiro_alerta_minutos * 60000).toISOString()
  const { data, error } = await supabase
    .from('conversas')
    .select('id, company_id, cliente_id, telefone, tipo, status_atendimento, atendente_id, atendente_original_id, ultima_mensagem_cliente_em, ultima_resposta_atendente_em, primeiro_alerta_enviado_em, alerta_critico_enviado_em, gestor_notificado_em, conversa_reaberta_por_sla_em, tag_aplicada_por_sla, nome_contato_cache, aguardando_cliente_desde')
    .eq('company_id', company_id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)
    .or(`ultima_mensagem_cliente_em.lte.${cutoff},ultima_mensagem_cliente_em.is.null`)
    .order('ultima_atividade', { ascending: true, nullsFirst: false })
    .limit(scanLimit)
  if (error) {
    console.warn('[alertaSemResposta] fetch conversas:', error.message || error)
    return []
  }
  return data || []
}

async function processConversation({ io, company_id, cfg, conv, dryRun = false }) {
  if (conv.aguardando_cliente_desde) return { conversa_id: conv.id, action: 'skip_waiting_client' }
  const isGroup = String(conv.tipo || '').toLowerCase() === 'grupo' || String(conv.telefone || '').includes('@g.us')
  if (isGroup) return { conversa_id: conv.id, action: 'skip_group' }

  const last = await getLastMessage(company_id, conv.id)
  if (!last) return { conversa_id: conv.id, action: 'skip_no_message' }

  if (last.direcao !== 'in') {
    if (last.autor_usuario_id != null) {
      if (!dryRun) await registrarRespostaAtendenteSemResposta({ company_id, conversa_id: conv.id, criado_em: last.criado_em })
      return { conversa_id: conv.id, action: 'reset_last_not_client' }
    }
    return { conversa_id: conv.id, action: 'skip_last_not_human' }
  }

  const lastClientAt = last.criado_em
  if (!conv.ultima_mensagem_cliente_em || new Date(conv.ultima_mensagem_cliente_em).getTime() !== new Date(lastClientAt).getTime()) {
    conv = { ...conv, ultima_mensagem_cliente_em: lastClientAt, primeiro_alerta_enviado_em: null, alerta_critico_enviado_em: null, gestor_notificado_em: null, conversa_reaberta_por_sla_em: null, tag_aplicada_por_sla: false }
    if (!dryRun) await registrarMensagemClienteSemResposta({ company_id, conversa_id: conv.id, criado_em: lastClientAt })
  }

  const minutos = minutesSince(lastClientAt)
  if (minutos == null || minutos < cfg.tempo_primeiro_alerta_minutos) return { conversa_id: conv.id, action: 'below_threshold', minutos }
  if (dryRun) return { conversa_id: conv.id, action: 'candidate', minutos, sla_status: conv.sla_status }

  const atendenteNome = await fetchAttendantName(company_id, conv.atendente_id)
  const clienteNome = conv.nome_contato_cache || conv.telefone || `Conversa ${conv.id}`
  const commonDetails = { cliente_nome: clienteNome, atendente_nome: atendenteNome }
  let actions = []

  if (!conv.primeiro_alerta_enviado_em && minutos >= cfg.tempo_primeiro_alerta_minutos) {
    const msg = `⚠️ Atencao: este cliente esta aguardando resposta ha ${minutos} minutos. Responda agora para evitar escalonamento.`
    const inserted = await recordAndNotify({ io, company_id, conv, tipo: EVENT_TYPES.FIRST, nivel: 'atencao', minutos, mensagem: msg, cfg, detalhes: commonDetails })
    if (inserted) {
      await supabase.from('conversas').update({ primeiro_alerta_enviado_em: new Date().toISOString(), sla_status: 'atencao' }).eq('company_id', company_id).eq('id', conv.id).is('primeiro_alerta_enviado_em', null)
      await insertHistory(conv.id, conv.atendente_id, EVENT_TYPES.FIRST, `Sistema enviou alerta de atencao ao atendente ${atendenteNome} apos ${minutos} minutos sem resposta.`)
      actions.push(EVENT_TYPES.FIRST)
    }
  }

  if (!conv.alerta_critico_enviado_em && minutos >= cfg.tempo_alerta_critico_minutos) {
    const finalAction = cfg.reabrir_conversa_automaticamente
      ? 'o gestor sera notificado e a conversa podera ser reaberta'
      : 'o gestor sera notificado para acompanhar a conversa'
    const msg = `🚨 Alerta critico: esta conversa esta sem resposta ha ${minutos} minutos. Se nao houver resposta, ${finalAction}.`
    const inserted = await recordAndNotify({ io, company_id, conv, tipo: EVENT_TYPES.CRITICAL, nivel: 'critico', minutos, mensagem: msg, cfg, detalhes: commonDetails })
    if (inserted) {
      await supabase.from('conversas').update({ alerta_critico_enviado_em: new Date().toISOString(), sla_status: 'critico' }).eq('company_id', company_id).eq('id', conv.id).is('alerta_critico_enviado_em', null)
      await insertHistory(conv.id, conv.atendente_id, EVENT_TYPES.CRITICAL, `Sistema enviou alerta critico ao atendente ${atendenteNome} apos ${minutos} minutos sem resposta.`)
      actions.push(EVENT_TYPES.CRITICAL)
    }
  }

  if (!conv.gestor_notificado_em && minutos >= cfg.tempo_notificar_gestor_minutos) {
    const { managerIds, gestorId, texto } = await notifyManagers({ io, company_id, conv, cfg, minutos, clienteNome, atendenteNome })
    const inserted = await insertEvent({
      company_id,
      conversa_id: conv.id,
      atendente_id: conv.atendente_id || conv.atendente_original_id || null,
      gestor_id: gestorId,
      tipo: EVENT_TYPES.MANAGER,
      nivel: 'gestor',
      minutos_sem_resposta: minutos,
      ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
      mensagem: texto,
      detalhes: {
        ...commonDetails,
        status_atendimento: conv.status_atendimento,
        responsaveis_notificacao_ids: managerIds,
        notificar_por_whatsapp: cfg.notificar_por_whatsapp,
        notificar_interno: cfg.notificar_interno,
        notificar_por_email: cfg.notificar_por_email,
        reabrir_conversa_automaticamente: cfg.reabrir_conversa_automaticamente,
      },
    })
    if (inserted) {
      if (cfg.notificar_interno) {
        await notifyManagersInternal({ io, company_id, conv, managerIds, gestorId, minutos, texto })
      }
      const whatsapp = await sendManagerWhatsApp({ company_id, conv, cfg, texto })
      if (!whatsapp.ok) {
        await insertEvent({
          company_id,
          conversa_id: conv.id,
          atendente_id: conv.atendente_id || conv.atendente_original_id || null,
          gestor_id: gestorId,
          tipo: EVENT_TYPES.WHATSAPP_FAILED,
          nivel: 'erro',
          minutos_sem_resposta: minutos,
          ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
          mensagem: `Falha ao enviar WhatsApp ao gestor: ${whatsapp.error}`,
          detalhes: { ...commonDetails, telefone_gestor: cfg.telefone_gestor, erro: whatsapp.error },
        })
        await insertHistory(conv.id, gestorId, EVENT_TYPES.WHATSAPP_FAILED, `Falha ao enviar WhatsApp ao gestor: ${whatsapp.error}`)
      }
      if (cfg.notificar_por_email) {
        await insertEvent({
          company_id,
          conversa_id: conv.id,
          atendente_id: conv.atendente_id || conv.atendente_original_id || null,
          gestor_id: gestorId,
          tipo: EVENT_TYPES.EMAIL_UNAVAILABLE,
          nivel: 'erro',
          minutos_sem_resposta: minutos,
          ultima_mensagem_cliente_em: conv.ultima_mensagem_cliente_em,
          mensagem: EMAIL_UNAVAILABLE_MESSAGE,
          detalhes: commonDetails,
        })
        await insertHistory(conv.id, gestorId, EVENT_TYPES.EMAIL_UNAVAILABLE, EMAIL_UNAVAILABLE_MESSAGE)
      }
      await supabase.from('conversas').update({ gestor_notificado_em: new Date().toISOString(), sla_status: 'gestor_notificado' }).eq('company_id', company_id).eq('id', conv.id).is('gestor_notificado_em', null)
      await insertHistory(conv.id, gestorId, EVENT_TYPES.MANAGER, `Sistema notificou o gestor/admin apos ${minutos} minutos sem resposta.`)
      actions.push(EVENT_TYPES.MANAGER)
    }

    if (cfg.aplicar_tag_automatica) {
      const tagged = await applyAutomaticTag(company_id, conv.id, cfg, conv)
      if (tagged) actions.push(EVENT_TYPES.TAG)
    }
    if (cfg.reabrir_conversa_automaticamente) {
      const reopened = await reopenConversation(company_id, conv, minutos)
      if (reopened) actions.push(EVENT_TYPES.REOPEN)
    }
  }

  return { conversa_id: conv.id, action: actions.length ? 'processed' : 'noop', actions, minutos }
}

async function processCompanyAlertaSemResposta({ company_id, io = null, dryRun = false }) {
  const { config: cfg } = await getAlertaSemRespostaConfig(company_id)
  if (!cfg.alerta_sem_resposta_ativo) return { ok: true, company_id, ativo: false, analisadas: 0, processadas: 0, detalhes: [] }
  if (!(await isWithinBusinessHours(company_id, cfg))) {
    return { ok: true, company_id, ativo: true, fora_horario_comercial: true, analisadas: 0, processadas: 0, detalhes: [] }
  }

  const conversas = await fetchEligibleConversations(Number(company_id), cfg)
  const detalhes = []
  let processadas = 0
  for (const conv of conversas) {
    const res = await processConversation({ io, company_id: Number(company_id), cfg, conv, dryRun })
    detalhes.push(res)
    if (res.action === 'processed' || res.action === 'candidate') processadas++
  }
  return { ok: true, company_id: Number(company_id), ativo: true, dryRun, analisadas: conversas.length, processadas, detalhes }
}

async function processAllCompaniesAlertaSemResposta({ io = null, dryRun = false } = {}) {
  const { data, error } = await supabase.from('ia_config').select('company_id, config')
  if (error) return { ok: false, error: error.message, empresas: 0, processadas: 0, detalhes: [] }
  let empresas = 0
  let processadas = 0
  const detalhes = []
  for (const row of data || []) {
    const full = parseIaConfigJson(row.config)
    const cfg = normalizeAlertaSemRespostaConfig(full.alerta_sem_resposta || full.alerta_atendimento_sem_resposta || {})
    if (!cfg.alerta_sem_resposta_ativo) continue
    empresas++
    const result = await processCompanyAlertaSemResposta({ company_id: row.company_id, io, dryRun })
    detalhes.push(result)
    processadas += Number(result.processadas || 0)
  }
  return { ok: true, dryRun, empresas, processadas, detalhes }
}

async function listAlertaSemRespostaEventos(company_id, opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100))
  let q = supabase
    .from('alerta_sem_resposta_eventos')
    .select('id, company_id, conversa_id, atendente_id, gestor_id, tipo, nivel, minutos_sem_resposta, ultima_mensagem_cliente_em, mensagem, detalhes, criado_em')
    .eq('company_id', Number(company_id))
    .order('criado_em', { ascending: false })
    .limit(limit)
  if (opts.conversa_id) q = q.eq('conversa_id', Number(opts.conversa_id))
  const { data, error } = await q
  if (error) throw error
  const eventos = data || []
  const conversaIds = [...new Set(eventos.map((e) => Number(e.conversa_id)).filter(Boolean))]
  const usuarioIds = [...new Set(eventos.flatMap((e) => [Number(e.atendente_id), Number(e.gestor_id)]).filter(Boolean))]
  const conversaMap = new Map()
  const usuarioMap = new Map()

  if (conversaIds.length) {
    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, nome_contato_cache, telefone, cliente_id')
      .eq('company_id', Number(company_id))
      .in('id', conversaIds)
    for (const c of conversas || []) {
      conversaMap.set(Number(c.id), c)
    }
  }

  if (usuarioIds.length) {
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('id, nome, email')
      .eq('company_id', Number(company_id))
      .in('id', usuarioIds)
    for (const u of usuarios || []) {
      usuarioMap.set(Number(u.id), u)
    }
  }

  return eventos.map((e) => {
    const detalhes = e.detalhes && typeof e.detalhes === 'object' ? { ...e.detalhes } : {}
    const conversa = conversaMap.get(Number(e.conversa_id))
    const atendente = usuarioMap.get(Number(e.atendente_id))
    const gestor = usuarioMap.get(Number(e.gestor_id))
    if (!detalhes.cliente_nome && conversa) detalhes.cliente_nome = conversa.nome_contato_cache || conversa.telefone || `Cliente ${conversa.cliente_id || e.conversa_id}`
    if (!detalhes.atendente_nome && atendente) detalhes.atendente_nome = atendente.nome || atendente.email || `Usuario ${e.atendente_id}`
    if (!detalhes.gestor_nome && gestor) detalhes.gestor_nome = gestor.nome || gestor.email || `Usuario ${e.gestor_id}`
    return { ...e, detalhes }
  })
}

module.exports = {
  DEFAULT_ALERTA_SEM_RESPOSTA_CONFIG,
  EVENT_TYPES,
  EMAIL_UNAVAILABLE_MESSAGE,
  normalizeAlertaSemRespostaConfig,
  validateAlertaSemRespostaConfigInput,
  buildManagerMessage,
  getAlertaSemRespostaConfig,
  saveAlertaSemRespostaConfig,
  registrarMensagemClienteSemResposta,
  registrarRespostaAtendenteSemResposta,
  processCompanyAlertaSemResposta,
  processAllCompaniesAlertaSemResposta,
  listAlertaSemRespostaEventos,
}
