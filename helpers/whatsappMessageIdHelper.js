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

/** Extrai mensagens.id a partir de referenceId UltraMSG (ex: crm-12345). */
function parseCrmReferenceMensagemId(referenceId) {
  const s = String(referenceId || '').trim()
  const m = s.match(/^crm-(\d+)$/i)
  if (!m) return null
  const id = Number(m[1])
  if (!Number.isFinite(id) || id <= 0) return null
  return Math.floor(id)
}

/** whatsapp_id ainda pendente de reconciliação com o id real do WhatsApp (null ou fila numérica). */
function isReconcilablePendingWhatsappId(whatsappId) {
  if (whatsappId == null) return true
  const s = String(whatsappId).trim()
  if (!s || s === 'null' || s === 'undefined') return true
  return isUltramsgNumericQueueId(s)
}

/**
 * Extrai o SID UltraMSG quando o id vem completo (false_jid@c.us_SID) ou como hex puro.
 * Usado para equivalência sid ↔ false_…_sid (mesmo envio, formatos diferentes).
 */
function extractUltramsgSid(waId) {
  const s = String(waId || '').trim()
  if (!s) return null
  const composed = s.match(/^(?:false|true)_.+?@[^_]+_(.+)$/i)
  if (composed) return String(composed[1] || '').trim() || null
  if (/^[A-F0-9]{12,}$/i.test(s)) return s
  return null
}

/** True quando dois ids representam o mesmo envio UltraMSG (string igual ou sid equivalente). */
function areEquivalentWhatsAppIds(a, b) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  if (x === y) return true
  const sx = extractUltramsgSid(x)
  const sy = extractUltramsgSid(y)
  if (sx && sy && sx.toLowerCase() === sy.toLowerCase()) return true
  if (x.length !== y.length) {
    const longer = x.length > y.length ? x : y
    const shorter = x.length > y.length ? y : x
    if (shorter.length >= 12 && longer.toLowerCase().endsWith(`_${shorter.toLowerCase()}`)) return true
  }
  return false
}

module.exports = {
  isRealWhatsAppId,
  extractUltraMsgMessageId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
  parseCrmReferenceMensagemId,
  isReconcilablePendingWhatsappId,
  extractUltramsgSid,
  areEquivalentWhatsAppIds,
}
