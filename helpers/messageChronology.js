const MIN_VALID_MESSAGE_TIME_MS = Date.UTC(2020, 0, 1)
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

function parseTimestampMillis(value) {
  if (value == null || value === '') return NaN
  if (value instanceof Date) return value.getTime()

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 1e11 ? value * 1000 : value
  }

  const raw = String(value).trim()
  if (!raw) return NaN
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw)
    if (!Number.isFinite(numeric)) return NaN
    return Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric
  }

  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : NaN
}

function normalizeMessageTimestamp(value, fallback = Date.now(), now = Date.now()) {
  let millis = parseTimestampMillis(value)
  const fallbackMillis = parseTimestampMillis(fallback)
  const safeFallback = Number.isFinite(fallbackMillis) ? fallbackMillis : now

  if (
    !Number.isFinite(millis) ||
    millis < MIN_VALID_MESSAGE_TIME_MS ||
    millis > now + MAX_FUTURE_SKEW_MS
  ) {
    millis = safeFallback
  }

  return new Date(millis).toISOString()
}

function getMessageTimestampValue(message) {
  const candidates = [
    message?.message_timestamp,
    message?.sent_at,
    message?.received_at,
    message?.criado_em,
    message?.created_at,
  ]
  return candidates.find((value) => Number.isFinite(parseTimestampMillis(value))) ?? null
}

function getMessageTimestampMillis(message) {
  return parseTimestampMillis(getMessageTimestampValue(message))
}

function compareMessagesChronologically(a, b) {
  const ta = getMessageTimestampMillis(a)
  const tb = getMessageTimestampMillis(b)
  const safeTa = Number.isFinite(ta) ? ta : 0
  const safeTb = Number.isFinite(tb) ? tb : 0
  if (safeTa !== safeTb) return safeTa - safeTb

  const ida = a?.id == null || a?.id === '' ? NaN : Number(a.id)
  const idb = b?.id == null || b?.id === '' ? NaN : Number(b.id)
  if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return ida - idb
  if (a?.id != null && b?.id != null) return String(a.id).localeCompare(String(b.id))
  return 0
}

function requestReceivedTimestamp(req) {
  return normalizeMessageTimestamp(req?.messageReceivedAt ?? req?.requestReceivedAt ?? Date.now())
}

function logMessageChronology(event, message = {}, extra = {}) {
  if (String(process.env.MESSAGE_ORDER_DEBUG || '').toLowerCase() !== 'true') return
  console.info('[message-order]', {
    event,
    mensagem_id: message?.id ?? message?.mensagem_id ?? null,
    whatsapp_id: message?.whatsapp_id ?? null,
    reference_id: message?.client_temp_id ?? message?.referenceId ?? null,
    conversa_id: message?.conversa_id ?? extra?.conversa_id ?? null,
    tipo: message?.tipo ?? extra?.tipo ?? null,
    has_media: Boolean(message?.url ?? extra?.has_media),
    provider_timestamp: extra?.provider_timestamp ?? null,
    message_timestamp: message?.message_timestamp ?? extra?.message_timestamp ?? null,
    criado_em: message?.criado_em ?? null,
    processing_started_at: extra?.processing_started_at ?? null,
    processing_finished_at: extra?.processing_finished_at ?? null,
    persisted_at: extra?.persisted_at ?? null,
    emitted_at: extra?.emitted_at ?? null,
    reason: extra?.reason ?? null,
  })
}

module.exports = {
  parseTimestampMillis,
  normalizeMessageTimestamp,
  getMessageTimestampValue,
  getMessageTimestampMillis,
  compareMessagesChronologically,
  requestReceivedTimestamp,
  logMessageChronology,
}
