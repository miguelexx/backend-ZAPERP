const supabase = require('../config/supabase')

const LIMIT_CODES = {
  messagesPerHour: 'LIMIT_MESSAGES_PER_HOUR',
  messagesPerDay: 'LIMIT_MESSAGES_PER_DAY',
  newConversationsPerHour: 'LIMIT_NEW_CONVERSATIONS_PER_HOUR',
  newConversationsPerDay: 'LIMIT_NEW_CONVERSATIONS_PER_DAY',
  messageInterval: 'MESSAGE_INTERVAL_ACTIVE',
  newConversationInterval: 'NEW_CONVERSATION_INTERVAL_ACTIVE',
  consecutiveMessages: 'CONSECUTIVE_MESSAGES_LIMIT',
  outsideAllowedHours: 'OUTSIDE_ALLOWED_HOURS',
}

const DEFAULT_LIMIT_CONFIG = Object.freeze({
  messages_per_hour_enabled: false,
  messages_per_hour: null,
  messages_per_day_enabled: false,
  messages_per_day: null,
  new_conversations_per_hour_enabled: false,
  new_conversations_per_hour: null,
  new_conversations_per_day_enabled: false,
  new_conversations_per_day: null,
  message_interval_seconds_enabled: false,
  message_interval_seconds: null,
  new_conversation_interval_seconds_enabled: false,
  new_conversation_interval_seconds: null,
  consecutive_without_reply_enabled: false,
  consecutive_without_reply: null,
  allowed_hours_enabled: false,
  allowed_days: [1, 2, 3, 4, 5],
  allowed_start: '08:00',
  allowed_end: '18:00',
  timezone: 'America/Sao_Paulo',
  allow_existing_replies_outside_hours: true,
  block_new_conversations_only: true,
})

function toPositiveInt(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function normalizeBool(value) {
  return value === true
}

function normalizeTime(value, fallback) {
  const text = String(value || '').trim()
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback
}

function normalizeAllowedDays(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_LIMIT_CONFIG.allowed_days
  const days = [...new Set(raw.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
  return days.length ? days : DEFAULT_LIMIT_CONFIG.allowed_days
}

function normalizeLimitConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    messages_per_hour_enabled: normalizeBool(src.messages_per_hour_enabled),
    messages_per_hour: toPositiveInt(src.messages_per_hour),
    messages_per_day_enabled: normalizeBool(src.messages_per_day_enabled),
    messages_per_day: toPositiveInt(src.messages_per_day),
    new_conversations_per_hour_enabled: normalizeBool(src.new_conversations_per_hour_enabled),
    new_conversations_per_hour: toPositiveInt(src.new_conversations_per_hour),
    new_conversations_per_day_enabled: normalizeBool(src.new_conversations_per_day_enabled),
    new_conversations_per_day: toPositiveInt(src.new_conversations_per_day),
    message_interval_seconds_enabled: normalizeBool(src.message_interval_seconds_enabled),
    message_interval_seconds: toPositiveInt(src.message_interval_seconds),
    new_conversation_interval_seconds_enabled: normalizeBool(src.new_conversation_interval_seconds_enabled),
    new_conversation_interval_seconds: toPositiveInt(src.new_conversation_interval_seconds),
    consecutive_without_reply_enabled: normalizeBool(src.consecutive_without_reply_enabled),
    consecutive_without_reply: toPositiveInt(src.consecutive_without_reply),
    allowed_hours_enabled: normalizeBool(src.allowed_hours_enabled),
    allowed_days: normalizeAllowedDays(src.allowed_days),
    allowed_start: normalizeTime(src.allowed_start, DEFAULT_LIMIT_CONFIG.allowed_start),
    allowed_end: normalizeTime(src.allowed_end, DEFAULT_LIMIT_CONFIG.allowed_end),
    timezone: String(src.timezone || DEFAULT_LIMIT_CONFIG.timezone).trim() || DEFAULT_LIMIT_CONFIG.timezone,
    allow_existing_replies_outside_hours: src.allow_existing_replies_outside_hours !== false,
    block_new_conversations_only: src.block_new_conversations_only !== false,
  }
}

function mergeLimitConfig(base = {}, override = {}) {
  return normalizeLimitConfig({
    ...DEFAULT_LIMIT_CONFIG,
    ...(base || {}),
    ...(override || {}),
  })
}

function isMissingLimitsSchemaError(error) {
  const text = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  return error?.code === '42P01' || error?.code === '42883' || error?.code === 'PGRST202' || text.includes('atendimento_limits')
}

function buildIdempotencyKey({ clientTempId, messageId, kind, fallback }) {
  const explicit = String(clientTempId || messageId || '').trim()
  if (explicit) return explicit.slice(0, 160)
  return String(fallback || kind || '').trim().slice(0, 160) || null
}

function normalizeLimitResult(data) {
  const raw = Array.isArray(data) ? data[0] : data
  if (!raw || typeof raw !== 'object') return { allowed: true, consumed: false }
  if (raw.allowed !== false) {
    return {
      allowed: true,
      consumed: raw.consumed === true,
      deduplicated: raw.deduplicated === true,
      is_new_conversation: raw.is_new_conversation === true,
    }
  }
  return {
    allowed: false,
    status: 429,
    limit: {
      code: raw.code || 'ATTENDANCE_LIMIT_REACHED',
      message: raw.message || 'Limite de atendimento atingido.',
      used: raw.used ?? null,
      limit: raw.limit ?? null,
      retry_after_seconds: raw.retry_after_seconds ?? null,
      release_at: raw.release_at ?? raw.reset_at ?? null,
      reset_at: raw.reset_at ?? null,
      is_new_conversation: raw.is_new_conversation === true,
    },
  }
}

function limitErrorResponse(limitResult) {
  const limit = limitResult?.limit || {}
  return {
    error: limit.message || 'Limite de atendimento atingido.',
    limit_code: limit.code || 'ATTENDANCE_LIMIT_REACHED',
    limit,
  }
}

async function validateAndConsumeForMessage(input = {}, client = supabase) {
  const companyId = Number(input.company_id)
  const usuarioId = Number(input.usuario_id ?? input.user_id)
  const conversaId = Number(input.conversa_id)
  if (!Number.isFinite(companyId) || !Number.isFinite(usuarioId) || !Number.isFinite(conversaId)) {
    return { allowed: true, consumed: false, skipped: 'invalid_context' }
  }

  const idempotencyKey = buildIdempotencyKey({
    clientTempId: input.client_temp_id,
    messageId: input.message_id,
    kind: input.message_type || 'mensagem',
    fallback: input.fallback_idempotency_key,
  })

  const { data, error } = await client.rpc('atendimento_limits_validate_and_consume', {
    p_company_id: companyId,
    p_usuario_id: usuarioId,
    p_conversa_id: conversaId,
    p_idempotency_key: idempotencyKey,
    p_message_type: String(input.message_type || 'texto').slice(0, 40),
  })

  if (error) {
    if (isMissingLimitsSchemaError(error)) {
      return { allowed: true, consumed: false, skipped: 'schema_missing' }
    }
    return {
      allowed: false,
      status: 500,
      limit: {
        code: 'ATTENDANCE_LIMIT_VALIDATION_ERROR',
        message: 'Nao foi possivel validar os limites de atendimento.',
      },
      error,
    }
  }

  return normalizeLimitResult(data)
}

async function getAtendimentoLimitsConfig(companyId, client = supabase) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) {
    return { enabled: false, default_config: DEFAULT_LIMIT_CONFIG, user_configs: [], history: [] }
  }

  const { data: company, error: companyError } = await client
    .from('atendimento_limits_company_configs')
    .select('*')
    .eq('company_id', cid)
    .maybeSingle()

  if (companyError && !isMissingLimitsSchemaError(companyError)) throw companyError

  let userConfigs = []
  let history = []
  if (!companyError) {
    const usersResult = await client
      .from('atendimento_limits_user_configs')
      .select('usuario_id, use_company_default, config, atualizado_em, atualizado_por')
      .eq('company_id', cid)
      .order('usuario_id', { ascending: true })
    if (usersResult.error && !isMissingLimitsSchemaError(usersResult.error)) throw usersResult.error
    userConfigs = usersResult.data || []

    const historyResult = await client
      .from('atendimento_limits_history')
      .select('id, admin_usuario_id, target_type, target_usuario_id, previous_value, new_value, criado_em')
      .eq('company_id', cid)
      .order('criado_em', { ascending: false })
      .limit(100)
    if (historyResult.error && !isMissingLimitsSchemaError(historyResult.error)) throw historyResult.error
    history = historyResult.data || []
  }

  return {
    enabled: company?.enabled === true,
    default_config: mergeLimitConfig(company?.default_config || DEFAULT_LIMIT_CONFIG),
    user_configs: userConfigs.map((row) => ({
      usuario_id: Number(row.usuario_id),
      use_company_default: row.use_company_default !== false,
      config: mergeLimitConfig(row.config || {}),
      atualizado_em: row.atualizado_em || null,
      atualizado_por: row.atualizado_por || null,
    })),
    history,
  }
}

async function saveCompanyLimitsConfig(companyId, adminUserId, payload = {}, client = supabase) {
  const cid = Number(companyId)
  const adminId = Number(adminUserId)
  const current = await getAtendimentoLimitsConfig(cid, client)
  const nextEnabled = payload.enabled === true
  const nextDefaultConfig = mergeLimitConfig(payload.default_config || current.default_config)

  const { data, error } = await client
    .from('atendimento_limits_company_configs')
    .upsert({
      company_id: cid,
      enabled: nextEnabled,
      default_config: nextDefaultConfig,
      timezone: nextDefaultConfig.timezone,
      atualizado_por: Number.isFinite(adminId) ? adminId : null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'company_id' })
    .select()
    .single()

  if (error) throw error
  await insertHistory(cid, adminId, 'company_default', null, current, {
    enabled: nextEnabled,
    default_config: nextDefaultConfig,
  }, client)
  return data
}

async function saveUserLimitsConfig(companyId, adminUserId, usuarioId, payload = {}, client = supabase) {
  const cid = Number(companyId)
  const uid = Number(usuarioId)
  const adminId = Number(adminUserId)
  const current = await getAtendimentoLimitsConfig(cid, client)
  const currentUser = current.user_configs.find((u) => Number(u.usuario_id) === uid) || null
  const useDefault = payload.use_company_default !== false
  const config = mergeLimitConfig(current.default_config, payload.config || {})

  const { data, error } = await client
    .from('atendimento_limits_user_configs')
    .upsert({
      company_id: cid,
      usuario_id: uid,
      use_company_default: useDefault,
      config,
      atualizado_por: Number.isFinite(adminId) ? adminId : null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'company_id,usuario_id' })
    .select()
    .single()

  if (error) throw error
  await insertHistory(cid, adminId, 'user', uid, currentUser, {
    usuario_id: uid,
    use_company_default: useDefault,
    config,
  }, client)
  return data
}

async function insertHistory(companyId, adminUserId, targetType, targetUsuarioId, previousValue, newValue, client = supabase) {
  try {
    await client.from('atendimento_limits_history').insert({
      company_id: Number(companyId),
      admin_usuario_id: Number.isFinite(Number(adminUserId)) ? Number(adminUserId) : null,
      target_type: targetType,
      target_usuario_id: targetUsuarioId == null ? null : Number(targetUsuarioId),
      previous_value: previousValue || null,
      new_value: newValue || null,
    })
  } catch (_) {}
}

module.exports = {
  LIMIT_CODES,
  DEFAULT_LIMIT_CONFIG,
  normalizeLimitConfig,
  mergeLimitConfig,
  validateAndConsumeForMessage,
  limitErrorResponse,
  getAtendimentoLimitsConfig,
  saveCompanyLimitsConfig,
  saveUserLimitsConfig,
  isMissingLimitsSchemaError,
}
