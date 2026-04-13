const { MAX_CONTENT_LENGTH, MESSAGE_TYPE } = require('../repositories/internalChatConstants')
const { orderedPair } = require('../helpers/internalChatParticipantPair')

/**
 * @param {number} companyId
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertPositiveCompanyId(companyId) {
  const n = Number(companyId)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'company_id inválido' }
  }
  return { ok: true }
}

/**
 * @param {number} companyId
 * @param {number} userIdA
 * @param {number} userIdB
 * @returns {{ ok: true, low: number, high: number, participant_pair_key: string } | { ok: false, error: string }}
 */
function validatePairRequest(companyId, userIdA, userIdB) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const ua = Number(userIdA)
  const ub = Number(userIdB)
  if (!Number.isFinite(ua) || ua <= 0 || !Number.isFinite(ub) || ub <= 0) {
    return { ok: false, error: 'user_id inválido' }
  }
  if (ua === ub) {
    return { ok: false, error: 'Não é permitido conversa interna com o próprio usuário' }
  }

  try {
    const { low, high, participant_pair_key } = orderedPair(ua, ub)
    return { ok: true, low, high, participant_pair_key }
  } catch (e) {
    return { ok: false, error: e?.message || 'Par inválido' }
  }
}

/**
 * @param {string} content
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
function validateMessageContent(content) {
  if (content === undefined || content === null) {
    return { ok: false, error: 'Conteúdo obrigatório' }
  }
  const text = typeof content === 'string' ? content : String(content)
  const noNulls = text.replace(/\u0000/g, '')
  const trimmed = noNulls.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'Mensagem vazia' }
  }
  if (noNulls.length > MAX_CONTENT_LENGTH) {
    return { ok: false, error: `Mensagem excede ${MAX_CONTENT_LENGTH} caracteres` }
  }
  return { ok: true, content: noNulls }
}

/**
 * @param {string} type
 * @returns {{ ok: true, message_type: string } | { ok: false, error: string }}
 */
function validateMessageType(type) {
  const t = type === undefined || type === null ? MESSAGE_TYPE.TEXT : String(type)
  if (t !== MESSAGE_TYPE.TEXT) {
    return { ok: false, error: 'message_type não suportado nesta fase' }
  }
  return { ok: true, message_type: t }
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, id: number } | { ok: false, error: string }}
 */
function parseRequiredUserId(raw, fieldName = 'target_user_id') {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `${fieldName} inválido` }
  }
  return { ok: true, id: n }
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, id: number } | { ok: false, error: string }}
 */
function parseConversationIdParam(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'id da conversa inválido' }
  }
  return { ok: true, id: n }
}

/**
 * @param {Record<string, unknown>} query
 * @returns {{ limit: number, before_id: number|null }}
 */
function parseMessagesPagination(query) {
  const lim = Math.min(100, Math.max(1, parseInt(String(query?.limit ?? '30'), 10) || 30))
  const rawBefore = query?.before_id
  if (rawBefore === undefined || rawBefore === null || rawBefore === '') {
    return { limit: lim, before_id: null }
  }
  const b = Number(rawBefore)
  if (!Number.isFinite(b) || b <= 0) {
    return { limit: lim, before_id: null }
  }
  return { limit: lim, before_id: b }
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseOptionalLastReadMessageId(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

module.exports = {
  assertPositiveCompanyId,
  validatePairRequest,
  validateMessageContent,
  validateMessageType,
  parseRequiredUserId,
  parseConversationIdParam,
  parseMessagesPagination,
  parseOptionalLastReadMessageId,
  MAX_CONTENT_LENGTH,
}
