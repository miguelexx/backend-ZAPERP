const {
  buildCrmReferenceId,
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
} = require('../helpers/whatsappMessageIdHelper')

const TERMINAL_STATUSES = new Set(['sent', 'delivered', 'read', 'played'])
const FAILED_PROVIDER_STATUSES = new Set(['error', 'erro', 'failed', 'failure', 'invalid', 'unsent', 'expired'])
const QUEUED_PROVIDER_STATUSES = new Set(['queue', 'queued', 'pending', 'sending'])
const ACCEPTED_PROVIDER_STATUSES = new Set(['sent', 'delivered', 'read', 'played', 'success', 'ok'])
const DEFAULT_RETRY_GRACE_MS = 60_000
const MAX_AUDIT_JSON_CHARS = 32_000

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return null
}

function providerMessageId(value) {
  if (!value || typeof value !== 'object') return null
  return firstNonEmpty(
    value.messageId,
    value.message_id,
    value.msgId,
    value.msg_id,
    value.id,
    value.wamid,
    value.whatsapp_id,
    value?.data?.messageId,
    value?.data?.id
  )
}

function redactAuditValue(key, value) {
  if (!key) return value
  const normalized = String(key).toLowerCase()
  if (
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('password') ||
    normalized.includes('secret')
  ) {
    return '[REDACTED]'
  }
  return value
}

function sanitizeAuditJson(value) {
  if (value == null) return null
  try {
    const serialized = JSON.stringify(value, (key, item) => redactAuditValue(key, item))
    if (!serialized) return null
    if (serialized.length <= MAX_AUDIT_JSON_CHARS) return JSON.parse(serialized)
    return {
      truncated: true,
      preview: serialized.slice(0, MAX_AUDIT_JSON_CHARS),
    }
  } catch (error) {
    return {
      serialization_error: String(error?.message || error).slice(0, 500),
      preview: String(value).slice(0, 2_000),
    }
  }
}

function isTimeoutError(error) {
  const name = normalizeStatus(error?.name)
  const code = normalizeStatus(error?.code || error?.cause?.code)
  const message = normalizeStatus(error?.message || error)
  return (
    name === 'aborterror' ||
    code.includes('timeout') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  )
}

function isNetworkError(error) {
  const code = normalizeStatus(error?.code || error?.cause?.code)
  const message = normalizeStatus(error?.message || error)
  return (
    code.startsWith('econn') ||
    code === 'enotfound' ||
    code === 'eai_again' ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket hang up') ||
    message.includes('connection reset')
  )
}

function isRetryableHttpStatus(status) {
  const code = Number(status)
  return code === 408 || code === 425 || code === 429 || code >= 500
}

/**
 * Contrato exclusivo do envio de texto manual:
 * - accepted: a UltraMsg aceitou e devolveu ID rastreável;
 * - queued: a UltraMsg aceitou e devolveu ID interno de fila;
 * - accepted_untracked: aceitou sem ID rastreável (permanece pendente);
 * - rejected: resposta explícita de não aceite;
 * - uncertain: timeout/rede/exceção ou falha com ID que ainda precisa ser consultado.
 */
function classifyManualTextProviderResult(result, thrownError = null) {
  if (thrownError) {
    const timeout = isTimeoutError(thrownError)
    const network = isNetworkError(thrownError)
    return {
      ok: false,
      accepted: false,
      queued: false,
      traceable: false,
      state: 'uncertain',
      status: 'erro',
      status_mensagem: 'failed',
      whatsapp_id: null,
      provider_queue_id: null,
      provider_http_status: null,
      provider_error: String(thrownError?.stack || thrownError?.message || thrownError).slice(0, 4_000),
      provider_response: null,
      // Exceção sem resposta é sempre tratada como transitória/incerta; nunca prova rejeição.
      retryable: true,
      timeout,
      network,
    }
  }

  const normalized = typeof result === 'boolean' ? { ok: result } : (result || {})
  const ok = normalized.ok === true
  const messageId = providerMessageId(normalized)
  const traceable = isRealWhatsAppId(messageId)
  const queued = ok && isUltramsgNumericQueueId(messageId)
  const httpStatus = Number.isFinite(Number(normalized.httpStatus))
    ? Number(normalized.httpStatus)
    : null
  const error = firstNonEmpty(normalized.error, normalized.blockedBy, normalized.message)

  if (ok) {
    return {
      ok: true,
      accepted: true,
      queued,
      traceable,
      state: traceable ? 'accepted' : queued ? 'queued' : 'accepted_untracked',
      status: traceable ? 'sent' : 'pending',
      status_mensagem: traceable ? 'sent' : 'sending',
      whatsapp_id: traceable ? messageId : null,
      provider_queue_id: queued ? messageId : null,
      provider_http_status: httpStatus,
      provider_error: null,
      provider_response: sanitizeAuditJson(normalized.rawResponse ?? normalized),
      retryable: false,
      timeout: false,
      network: false,
    }
  }

  const timeout = isTimeoutError(error)
  const network = isNetworkError(error)
  const hasProviderId = !!messageId
  return {
    ok: false,
    accepted: false,
    queued: false,
    traceable: false,
    state: hasProviderId || timeout || network || isRetryableHttpStatus(httpStatus) ? 'uncertain' : 'rejected',
    status: 'erro',
    status_mensagem: 'failed',
    whatsapp_id: null,
    provider_queue_id: isUltramsgNumericQueueId(messageId) ? messageId : null,
    provider_http_status: httpStatus,
    provider_error: String(error || `UltraMsg rejeitou o envio${httpStatus ? ` (HTTP ${httpStatus})` : ''}`).slice(0, 4_000),
    provider_response: sanitizeAuditJson(normalized.rawResponse ?? normalized),
    retryable: timeout || network || isRetryableHttpStatus(httpStatus),
    timeout,
    network,
  }
}

async function executeManualTextProviderAttempt(provider, phone, text, options) {
  try {
    const result = await provider.sendText(phone, text, options)
    return classifyManualTextProviderResult(result)
  } catch (error) {
    return classifyManualTextProviderResult(null, error)
  }
}

function isTerminalManualTextStatus(rowOrStatus) {
  const status = typeof rowOrStatus === 'object'
    ? normalizeStatus(rowOrStatus?.status_mensagem || rowOrStatus?.status)
    : normalizeStatus(rowOrStatus)
  return TERMINAL_STATUSES.has(status)
}

function manualTextHasProviderAcceptance(row) {
  if (!row) return false
  const state = normalizeStatus(row.provider_delivery_state)
  return (
    isTerminalManualTextStatus(row) ||
    isRealWhatsAppId(row.whatsapp_id) ||
    ['accepted', 'queued', 'accepted_untracked'].includes(state) ||
    (!state && isUltramsgNumericQueueId(row.provider_queue_id))
  )
}

function providerRowStatus(row) {
  return normalizeStatus(
    row?.status ||
    row?.ack ||
    row?.state ||
    row?.message_status ||
    row?.data?.status
  )
}

function providerRowReferenceId(row) {
  return firstNonEmpty(row?.referenceId, row?.reference_id, row?.data?.referenceId)
}

function classifyProviderLookupRows(rows, referenceId, expectedProviderId = null) {
  const candidates = Array.isArray(rows) ? rows : []
  const scoped = referenceId
    ? candidates.filter((row) => {
        const rowReference = providerRowReferenceId(row)
        if (rowReference) return rowReference === referenceId
        return expectedProviderId && providerMessageId(row) === String(expectedProviderId)
      })
    : candidates

  let queued = null
  let failed = null
  for (const row of scoped) {
    const status = providerRowStatus(row)
    const messageId = providerMessageId(row)
    // O status explícito do provedor prevalece sobre o formato do ID.
    // Uma linha "invalid" pode ter ID; isso não a transforma em aceita.
    if (FAILED_PROVIDER_STATUSES.has(status)) {
      failed = failed || { kind: 'failed', row, messageId: messageId || null }
      continue
    }
    if (QUEUED_PROVIDER_STATUSES.has(status)) {
      queued = queued || { kind: 'queued', row, messageId: isUltramsgNumericQueueId(messageId) ? messageId : null }
      continue
    }
    if (ACCEPTED_PROVIDER_STATUSES.has(status)) {
      return { kind: 'accepted', row, messageId: isRealWhatsAppId(messageId) ? messageId : null }
    }
    if (isRealWhatsAppId(messageId)) {
      return { kind: 'accepted', row, messageId }
    }
    if (isUltramsgNumericQueueId(messageId)) {
      queued = queued || { kind: 'queued', row, messageId }
    }
  }
  return queued || failed || { kind: 'none', row: null, messageId: null }
}

function extractLookupRows(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.messages)) return result.messages
  if (Array.isArray(result?.data)) return result.data
  if (Array.isArray(result?.data?.messages)) return result.data.messages
  return []
}

/**
 * Consulta a mensagem individualmente pelo referenceId. Não usa o lote global de
 * pendências, portanto mensagens antigas não impedem a verificação desta mensagem nova.
 */
async function lookupManualTextAtProvider(provider, row, {
  companyId,
  conversaId,
  whatsappInstanceId,
} = {}) {
  if (!provider || typeof provider.getMessages !== 'function') {
    return { kind: 'indeterminate', error: 'Provider sem consulta de mensagens' }
  }

  const referenceId = row?.provider_reference_id || buildCrmReferenceId(row?.id)
  const expectedProviderId = firstNonEmpty(row?.provider_queue_id, row?.whatsapp_id)
  if (!referenceId) return { kind: 'indeterminate', error: 'referenceId ausente' }

  const statuses = ['all', 'sent', 'queue', 'unsent', 'invalid', 'expired']
  let successfulLookup = false
  let lastError = null
  let collected = []

  for (const status of statuses) {
    try {
      const result = await provider.getMessages({
        companyId,
        conversaId,
        whatsappInstanceId,
        referenceId,
        ...(expectedProviderId ? { id: expectedProviderId } : {}),
        status,
        page: 1,
        limit: 100,
      })
      if (result?.ok === false) {
        lastError = result?.error || `Consulta UltraMsg falhou (${status})`
        continue
      }
      successfulLookup = true
      collected = collected.concat(extractLookupRows(result))
      const classification = classifyProviderLookupRows(collected, referenceId, expectedProviderId)
      if (classification.kind !== 'none') {
        return {
          ...classification,
          referenceId,
          response: sanitizeAuditJson(result?.rawResponse ?? result),
        }
      }
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }

  if (!successfulLookup) {
    return {
      kind: 'indeterminate',
      referenceId,
      error: String(lastError || 'Não foi possível consultar a UltraMsg').slice(0, 2_000),
    }
  }
  if (collected.length > 0) {
    return {
      kind: 'indeterminate',
      referenceId,
      error: 'A UltraMsg retornou mensagens sem correlação exata com o referenceId; nada será reenviado.',
      response: sanitizeAuditJson(collected),
    }
  }
  return { kind: 'none', referenceId, response: sanitizeAuditJson(collected) }
}

function getManualTextRetryGraceMs() {
  const configured = Number(process.env.MANUAL_TEXT_RETRY_GRACE_SECONDS)
  if (!Number.isFinite(configured)) return DEFAULT_RETRY_GRACE_MS
  return Math.min(10 * 60_000, Math.max(15_000, Math.floor(configured * 1_000)))
}

function retryAgeMs(row, now = Date.now()) {
  const timestamp = Date.parse(row?.provider_last_attempt_at || row?.criado_em || '')
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY
}

function decideManualTextRetry({
  row,
  retryRequested,
  providerLookup,
  now = Date.now(),
  graceMs = getManualTextRetryGraceMs(),
}) {
  if (manualTextHasProviderAcceptance(row)) {
    return { action: 'do_not_send', reason: 'already_accepted', ok: true, httpStatus: 200 }
  }

  if (providerLookup?.kind === 'accepted' || providerLookup?.kind === 'queued') {
    return { action: 'confirm_provider', reason: providerLookup.kind, ok: true, httpStatus: 200 }
  }
  if (providerLookup?.kind === 'indeterminate') {
    return {
      action: 'do_not_send',
      reason: 'provider_check_failed',
      ok: false,
      retryable: true,
      httpStatus: 503,
    }
  }
  if (!retryRequested) {
    return {
      action: 'do_not_send',
      reason: 'retry_not_requested',
      ok: false,
      retryable: row?.provider_retryable !== false,
      httpStatus: normalizeStatus(row?.status) === 'erro' ? 502 : 409,
    }
  }

  if (providerLookup?.kind === 'failed') {
    return { action: 'send', reason: 'provider_confirmed_failure', ok: false, retryable: true }
  }

  const state = normalizeStatus(row?.provider_delivery_state)
  if (state === 'rejected') {
    return { action: 'send', reason: 'provider_rejected_previous_attempt', ok: false, retryable: true }
  }

  const age = retryAgeMs(row, now)
  if (age < graceMs) {
    return {
      action: 'do_not_send',
      reason: 'uncertain_attempt_in_grace_period',
      ok: false,
      retryable: true,
      httpStatus: 409,
      retryAfterMs: graceMs - age,
    }
  }

  return {
    action: 'send',
    reason: 'provider_has_no_record_after_grace',
    ok: false,
    retryable: true,
  }
}

function buildManualTextProviderAuditPatch({
  row,
  classification,
  referenceId,
  request,
  attemptedAt,
}) {
  return {
    provider_reference_id: referenceId || buildCrmReferenceId(row?.id),
    provider_request: sanitizeAuditJson(request),
    provider_delivery_state: classification.state,
    provider_http_status: classification.provider_http_status,
    provider_response: classification.provider_response,
    provider_error: classification.provider_error,
    provider_retryable: !!classification.retryable,
    provider_last_attempt_at: attemptedAt || new Date().toISOString(),
  }
}

function buildManualTextProviderConfirmationPatch(providerLookup) {
  const messageId = providerLookup?.messageId || providerMessageId(providerLookup?.row)
  const accepted = providerLookup?.kind === 'accepted'
  const queued = providerLookup?.kind === 'queued'
  return {
    status: accepted ? 'sent' : 'pending',
    status_mensagem: accepted ? 'sent' : 'sending',
    provider_delivery_state: accepted ? 'accepted' : 'queued',
    provider_response: sanitizeAuditJson(providerLookup?.response ?? providerLookup?.row),
    provider_error: null,
    provider_retryable: false,
    ...(accepted && isRealWhatsAppId(messageId) ? { whatsapp_id: messageId } : {}),
    ...(queued && isUltramsgNumericQueueId(messageId) ? { provider_queue_id: messageId } : {}),
  }
}

function manualTextResponseFromClassification(classification, row, extra = {}) {
  const base = {
    ok: classification.ok === true,
    id: row?.id,
    conversa_id: Number(row?.conversa_id),
    ...(row?.client_temp_id ? { client_temp_id: row.client_temp_id } : {}),
    status: classification.status,
    status_mensagem: classification.status_mensagem,
    accepted: classification.accepted === true,
    queued: classification.queued === true,
    retryable: classification.retryable === true,
    ...(classification.whatsapp_id ? { whatsapp_id: classification.whatsapp_id } : {}),
    ...(classification.provider_queue_id ? { provider_queue_id: classification.provider_queue_id } : {}),
    ...(classification.provider_error ? {
      error: classification.provider_error,
      motivo: classification.provider_error,
    } : {}),
    ...extra,
  }
  return base
}

module.exports = {
  classifyManualTextProviderResult,
  executeManualTextProviderAttempt,
  isTerminalManualTextStatus,
  manualTextHasProviderAcceptance,
  classifyProviderLookupRows,
  lookupManualTextAtProvider,
  decideManualTextRetry,
  buildManualTextProviderAuditPatch,
  buildManualTextProviderConfirmationPatch,
  manualTextResponseFromClassification,
  sanitizeAuditJson,
  getManualTextRetryGraceMs,
  _test: {
    isTimeoutError,
    isNetworkError,
    retryAgeMs,
    providerMessageId,
  },
}
