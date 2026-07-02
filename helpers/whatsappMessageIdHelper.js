/**
 * Helpers para validar IDs de mensagem WhatsApp/UltraMSG.
 */

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue
    const s = String(value).trim()
    if (s) return s
  }
  return null
}

/** UltraMsg retorna id interno (ex: 35096) ou id real do WhatsApp. */
function isRealWhatsAppId(waId) {
  if (!waId) return false
  const s = String(waId).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
  if (s.includes('@')) return true
  if (/^[A-F0-9]{12,}$/i.test(s)) return true
  if (s.length > 20) return true
  return false
}

function extractUltraMsgMessageId(data) {
  if (!data || typeof data !== 'object') return null
  return firstNonEmpty(
    data.id,
    data.messageId,
    data.message_id,
    data.msgId,
    data.msg_id,
    data.wamid,
    data.whatsapp_id,
    data?.data?.id,
    data?.data?.messageId
  )
}

function isUltramsgNumericQueueId(waId) {
  const s = String(waId || '').trim()
  return /^\d{1,15}$/.test(s)
}

function buildCrmReferenceId(mensagemId) {
  const id = Number(mensagemId)
  if (!Number.isFinite(id) || id <= 0) return null
  return `crm-${Math.floor(id)}`
}

module.exports = {
  isRealWhatsAppId,
  extractUltraMsgMessageId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
}
