/**
 * Guarda PURA: o chatbot/URA de boas-vindas só dispara para mensagem real do contato
 * na conversa privada com o WhatsApp da empresa.
 *
 * Não usa telefone de `participant`/`author` como prova de chat privado — esses campos
 * identificam QUEM reagiu/falou dentro de grupo ou Status, não QUAL conversa é.
 */

const { normalizeGroupIdForStorage } = require('../../helpers/phoneHelper')

const CHATBOT_ALLOWED_TYPES = new Set([
  'text',
  'chat',
  'image',
  'audio',
  'ptt',
  'voice',
  'video',
  'document',
  'file',
  'sticker',
  'location',
  'contact',
  'vcard',
  'link',
])

const SYSTEM_OR_ACK_TYPES = new Set([
  'ack',
  'message_ack',
  'webhook_message_ack',
  'messagestatuscallback',
  'deliverycallback',
  'protocol',
  'gp2',
  'e2e_notification',
  'notification',
  'system',
  'call_log',
  'ciphertext',
  'revoked',
  'revoke',
  'deleted',
  'edit',
])

function asJid(v) {
  return String(v == null ? '' : v).trim()
}

function jidLooksGroup(v) {
  const s = asJid(v).toLowerCase()
  if (!s) return false
  return s.endsWith('@g.us') || s.includes('-group')
}

function jidLooksStatusOrBroadcast(v) {
  const s = asJid(v).toLowerCase()
  if (!s) return false
  return s.includes('status@broadcast') || s.endsWith('@broadcast') || s.includes('@newsletter')
}

function isReactionPayload(payload, type) {
  const t = String(type || payload?.type || payload?.msgType || '').toLowerCase()
  if (t === 'reaction' || t === 'reactionmessage') return true
  const eventType = String(payload?.event_type || payload?.eventType || '').toLowerCase()
  if (eventType.includes('reaction')) return true
  return !!(payload && typeof payload.reaction === 'object' && payload.reaction)
}

/**
 * JIDs do CHAT (origem), nunca do participante.
 * Em reação, o alvo (quotedMsg) é a origem real — o `from` costuma ser só quem reagiu.
 */
function collectChatOriginJids(payload) {
  if (!payload || typeof payload !== 'object') return []
  const jids = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.to,
    payload.from,
    payload.groupId,
    payload.group?.id,
    payload.data?.from,
    payload.data?.to,
    payload.data?.chatId,
    payload.data?.remoteJid,
    payload.data?.key?.remoteJid,
  ]
  if (isReactionPayload(payload)) {
    const quoted = payload.quotedMsg && typeof payload.quotedMsg === 'object' ? payload.quotedMsg : null
    jids.push(
      quoted?.from,
      quoted?.chatId,
      quoted?.remoteJid,
      quoted?.to,
      payload.reaction?.chatId,
      payload.reaction?.remoteJid,
      payload.reaction?.from,
    )
  }
  return jids.map(asJid).filter(Boolean)
}

function inspectInboundOrigin(payload) {
  const jids = collectChatOriginJids(payload)
  const groupJid = jids.find(jidLooksGroup) || ''
  const isStatusBroadcast = jids.some(jidLooksStatusOrBroadcast) || Boolean(payload?.isStatusBroadcast)
  return {
    isGroup: Boolean(payload?.isGroup) || Boolean(payload?.isGroupMsg) || !!groupJid,
    isStatusBroadcast,
    groupChatId: groupJid ? (normalizeGroupIdForStorage(groupJid) || groupJid) : '',
    groupJid,
    isReaction: isReactionPayload(payload),
  }
}

/**
 * @param {object} args
 * @param {boolean} [args.fromMe]
 * @param {boolean} [args.isGroup]
 * @param {string} [args.type]
 * @param {string} [args.phone]
 * @param {object} [args.payload]
 * @returns {{ ok: boolean, reason: string }}
 */
function shouldTriggerChatbotForInbound({ fromMe, isGroup, type, phone, payload } = {}) {
  if (fromMe) return { ok: false, reason: 'from_me' }
  if (isGroup) return { ok: false, reason: 'group' }

  const origin = inspectInboundOrigin(payload)
  if (origin.isStatusBroadcast) return { ok: false, reason: 'status_broadcast' }
  if (origin.isGroup) return { ok: false, reason: 'group_origin' }
  if (origin.isReaction || isReactionPayload(payload, type)) return { ok: false, reason: 'reaction' }

  const t = String(type || payload?.type || '').toLowerCase()
  if (SYSTEM_OR_ACK_TYPES.has(t)) return { ok: false, reason: 'system_or_ack' }
  if (jidLooksStatusOrBroadcast(phone) || jidLooksGroup(phone)) {
    return { ok: false, reason: 'non_private_key' }
  }
  if (t && !CHATBOT_ALLOWED_TYPES.has(t)) return { ok: false, reason: `type_${t}` }

  return { ok: true, reason: 'private_customer_message' }
}

module.exports = {
  shouldTriggerChatbotForInbound,
  inspectInboundOrigin,
  isReactionPayload,
  collectChatOriginJids,
  jidLooksGroup,
  jidLooksStatusOrBroadcast,
}
