/**
 * Interpretação da resposta de ENVIO Whapi.
 * HTTP 401/403, `sent=false`, ou ausência de id NÃO é sucesso (espelha o espírito do UltraMSG).
 * Whapi (CONFIRMADO OpenAPI SentMessage): POST /messages/* responde
 * `{ sent: true, message?: { id, ... } }`. `sent` é obrigatório; `message.id` é o wamid
 * síncrono quando presente (reconciliação fromMe por whatsapp_id, sem referenceId).
 */

function isFalseLike(value) {
  if (value === false || value === 0) return true
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'false' || s === '0' || s === 'no' || s === 'error' || s === 'failed'
}

function isTrueLike(value) {
  if (value === true || value === 1) return true
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'ok' || s === 'success' || s === 'sent'
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue
    const s = String(value).trim()
    if (s) return s
  }
  return null
}

/** Extrai o id da mensagem da resposta Whapi (vários formatos possíveis). */
function extractWhapiMessageId(data) {
  if (!data || typeof data !== 'object') return null
  return firstNonEmpty(
    data.id,
    data.message_id,
    data.messageId,
    data?.message?.id,
    data?.message?.message_id,
    Array.isArray(data.messages) ? data.messages[0]?.id : null,
    data?.sent && typeof data.sent === 'object' ? data.sent.id : null,
    data.wamid
  )
}

/**
 * Normaliza a resposta de envio para o contrato interno { ok, messageId, error, ... }
 * (mesmo espírito de normalizeUltraMsgSendResult — objeto, nunca boolean).
 */
function normalizeWhapiSendResult({ httpOk, status, data, text, fallbackError }) {
  const messageId = extractWhapiMessageId(data)
  const explicitError =
    data && typeof data === 'object'
      ? firstNonEmpty(
          data.error && !isFalseLike(data.error) ? (data.error.message || data.error) : null,
          data.message && isFalseLike(data.sent) ? data.message : null,
          data.detail,
          isFalseLike(data.sent) ? 'Whapi retornou sent=false' : null,
          isFalseLike(data.success) ? 'Whapi retornou success=false' : null
        )
      : null
  const acceptedByBody =
    !!messageId ||
    (data && typeof data === 'object' && (
      isTrueLike(data.sent) ||
      isTrueLike(data.success) ||
      isTrueLike(data.ok)
    ))

  if (!httpOk || explicitError || !acceptedByBody) {
    return {
      ok: false,
      messageId: messageId || null,
      httpStatus: status ?? null,
      error: String(explicitError || fallbackError || text || `HTTP ${status || 'erro'} sem aceite do provedor`).slice(0, 500),
      rawResponse: data ?? text ?? null,
    }
  }

  return {
    ok: true,
    messageId: messageId || null,
    httpStatus: status ?? null,
    error: null,
    rawResponse: data ?? text ?? null,
  }
}

module.exports = {
  isFalseLike,
  isTrueLike,
  firstNonEmpty,
  extractWhapiMessageId,
  normalizeWhapiSendResult,
}
