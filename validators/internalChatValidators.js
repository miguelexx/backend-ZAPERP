const {
  MAX_CONTENT_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_ORG_LENGTH,
  MESSAGE_TYPE,
  ALL_MESSAGE_TYPES,
} = require('../repositories/internalChatConstants')
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
 * Legenda opcional (mídia).
 * @param {unknown} content
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
function validateOptionalCaption(content) {
  if (content === undefined || content === null || content === '') {
    return { ok: true, content: '' }
  }
  const text = typeof content === 'string' ? content : String(content)
  const noNulls = text.replace(/\u0000/g, '')
  if (noNulls.length > MAX_CONTENT_LENGTH) {
    return { ok: false, error: `Legenda excede ${MAX_CONTENT_LENGTH} caracteres` }
  }
  return { ok: true, content: noNulls }
}

/**
 * @param {unknown} type
 * @returns {{ ok: true, message_type: string } | { ok: false, error: string }}
 */
function validateMessageType(type) {
  const raw =
    type === undefined || type === null || type === ''
      ? MESSAGE_TYPE.TEXT
      : String(type).trim().toLowerCase()
  if (!ALL_MESSAGE_TYPES.includes(raw)) {
    return { ok: false, error: `message_type inválido (use: ${ALL_MESSAGE_TYPES.join(', ')})` }
  }
  return { ok: true, message_type: raw }
}

/**
 * @param {object} body
 * @returns {{ ok: true, payload: object, content: string } | { ok: false, error: string }}
 */
function validateLocationMessage(body) {
  const latRaw = body?.latitude ?? body?.lat ?? body?.payload?.latitude
  const lngRaw = body?.longitude ?? body?.lng ?? body?.payload?.longitude
  const lat = typeof latRaw === 'string' ? parseFloat(latRaw) : Number(latRaw)
  const lng = typeof lngRaw === 'string' ? parseFloat(lngRaw) : Number(lngRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'latitude e longitude obrigatórios e numéricos' }
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: 'Coordenadas fora do intervalo válido' }
  }
  let address = body?.address ?? body?.payload?.address
  if (address != null) {
    address = String(address).replace(/\u0000/g, '').trim()
    if (address.length > MAX_ADDRESS_LENGTH) {
      return { ok: false, error: `Endereço excede ${MAX_ADDRESS_LENGTH} caracteres` }
    }
  } else {
    address = undefined
  }
  const cap = validateOptionalCaption(body?.content ?? body?.caption)
  if (!cap.ok) return cap

  const payload = { latitude: lat, longitude: lng }
  if (address) payload.address = address

  return { ok: true, payload, content: cap.content || '' }
}

/**
 * @param {object} body
 * @returns {{ ok: true, payload: object, content: string } | { ok: false, error: string }}
 */
function validateContactMessage(body) {
  const src = body?.contact && typeof body.contact === 'object' ? body.contact : body
  let name = src?.name != null ? String(src.name).replace(/\u0000/g, '').trim() : ''
  let phone = src?.phone != null ? String(src.phone).replace(/\u0000/g, '').trim() : ''
  if (!name) {
    return { ok: false, error: 'Nome do contato obrigatório' }
  }
  if (!phone) {
    return { ok: false, error: 'Telefone do contato obrigatório' }
  }
  if (name.length > MAX_CONTACT_NAME_LENGTH) {
    return { ok: false, error: `Nome excede ${MAX_CONTACT_NAME_LENGTH} caracteres` }
  }
  if (phone.length > MAX_PHONE_LENGTH) {
    return { ok: false, error: `Telefone excede ${MAX_PHONE_LENGTH} caracteres` }
  }
  if (!/^[\d\s+().-]+$/.test(phone)) {
    return { ok: false, error: 'Telefone com formato inválido' }
  }
  let organization = src?.organization
  if (organization != null) {
    organization = String(organization).replace(/\u0000/g, '').trim()
    if (organization.length > MAX_ORG_LENGTH) {
      return { ok: false, error: `Organização excede ${MAX_ORG_LENGTH} caracteres` }
    }
  } else {
    organization = undefined
  }
  const cap = validateOptionalCaption(body?.content ?? body?.caption)
  if (!cap.ok) return cap

  const payload = { name, phone }
  if (organization) payload.organization = organization

  return { ok: true, payload, content: cap.content || '' }
}

/**
 * URL de mídia servida pelo próprio backend (upload interno).
 * @param {string} url
 * @returns {{ ok: true, media_url: string } | { ok: false, error: string }}
 */
function validateInternalMediaUrl(url) {
  if (url == null || typeof url !== 'string') {
    return { ok: false, error: 'media_url inválida' }
  }
  const u = url.trim()
  if (!u.startsWith('/uploads/')) {
    return { ok: false, error: 'media_url deve começar com /uploads/' }
  }
  if (u.includes('..') || u.includes('\\')) {
    return { ok: false, error: 'media_url inválida' }
  }
  return { ok: true, media_url: u }
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
  validateOptionalCaption,
  validateMessageType,
  validateLocationMessage,
  validateContactMessage,
  validateInternalMediaUrl,
  parseRequiredUserId,
  parseConversationIdParam,
  parseMessagesPagination,
  parseOptionalLastReadMessageId,
  MAX_CONTENT_LENGTH,
}
