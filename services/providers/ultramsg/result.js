/**
 * Interpretação da resposta de ENVIO UltraMSG.
 * HTTP 200 com JSON de erro (token inválido, sent=false) NÃO é sucesso.
 */

const { invalidateEmpresaWhatsappConfigCache } = require('../../whatsappConfigService')

/** Resposta HTTP 200 com JSON de erro (ex.: token inválido após rotação no painel UltraMSG). */
function ultramsgResponseIndicatesBadInstanceToken(data, text) {
  const parts = []
  if (data && typeof data === 'object') {
    if (data.error != null && data.error !== false) parts.push(String(data.error))
    if (data.message != null) parts.push(String(data.message))
  }
  parts.push(String(text || ''))
  const lower = parts.join(' ').toLowerCase()
  return (
    lower.includes('wrong token') ||
    lower.includes('invalid token') ||
    lower.includes('invalid api token') ||
    lower.includes('unauthorized')
  )
}

function maybeInvalidateCacheOnBadToken(companyId, data, text) {
  if (companyId == null || !Number.isFinite(Number(companyId))) return
  if (!ultramsgResponseIndicatesBadInstanceToken(data, text)) return
  invalidateEmpresaWhatsappConfigCache(Number(companyId))
  console.warn(
    '[ULTRAMSG] instance_token rejeitado pela API — atualize `empresa_zapi.instance_token` com o token atual do painel UltraMSG (empresa ' +
      Number(companyId) +
      '). Cache de credenciais desta empresa foi limpo.'
  )
}

function isFalseLike(value) {
  if (value === false || value === 0) return true
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'false' || s === '0' || s === 'no' || s === 'erro' || s === 'error' || s === 'failed'
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

function normalizeUltraMsgSendResult({ httpOk, status, data, text, fallbackError }) {
  const messageId = extractUltraMsgMessageId(data)
  const explicitError =
    data && typeof data === 'object'
      ? firstNonEmpty(
          data.error && !isFalseLike(data.error) ? data.error : null,
          data.errors,
          data.exception,
          isFalseLike(data.sent) ? data.message || 'UltraMsg retornou sent=false' : null,
          isFalseLike(data.success) ? data.message || 'UltraMsg retornou success=false' : null,
          isFalseLike(data.status) ? data.message || `UltraMsg retornou status=${data.status}` : null
        )
      : null
  const acceptedByBody =
    !!messageId ||
    (data && typeof data === 'object' && (
      isTrueLike(data.sent) ||
      isTrueLike(data.success) ||
      isTrueLike(data.ok) ||
      isTrueLike(data.status)
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
  ultramsgResponseIndicatesBadInstanceToken,
  maybeInvalidateCacheOnBadToken,
  isFalseLike,
  isTrueLike,
  firstNonEmpty,
  extractUltraMsgMessageId,
  normalizeUltraMsgSendResult,
}
