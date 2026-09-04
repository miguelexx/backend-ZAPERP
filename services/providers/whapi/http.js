/**
 * HTTP Whapi: JSON + Authorization: Bearer <token>, token mascarado em log,
 * retry SÓ de erro de conexão no POST/PUT/PATCH (timeout/resposta ambígua NÃO repete — duplicaria).
 * Reusa whatsappSendGuardService (espaça por whatsappInstanceId) e helpers/retryWithBackoff.
 * PATCH /settings e POST /media usam skipSendGuard: true (não disparam WhatsApp).
 */

const { fetchWithRetry } = require('../../../helpers/retryWithBackoff')
const {
  beforeWhatsAppSend,
  afterWhatsAppSend,
} = require('../../whatsappSendGuardService')
const { WHAPI_BASE_URL, WHAPI_TIMEOUT_MS, WHATSAPP_DEBUG } = require('./constants')

/** Base URL Whapi — sem prefixo "instance" (o channel id NÃO entra na URL; vai no Bearer). */
function buildBaseUrl() {
  return WHAPI_BASE_URL
}

/** Mascara token em logs — nunca expor segredos. */
function maskToken(t) {
  if (!t || typeof t !== 'string') return '***'
  if (t.length <= 4) return '****'
  return t.slice(0, 2) + '***' + t.slice(-2)
}

function maskTokenInLogs(t) {
  return maskToken(t)
}

/** Valida campos obrigatórios; retorna { valid, error }. */
function validateRequiredFields(obj, required) {
  if (!obj || typeof obj !== 'object') return { valid: false, error: 'payload inválido' }
  const missing = required.filter((k) => obj[k] == null || String(obj[k]).trim() === '')
  if (missing.length) return { valid: false, error: `Campos obrigatórios: ${missing.join(', ')}` }
  return { valid: true }
}

function truncateForLog(s, maxLen = 500) {
  if (s == null) return s
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...[truncado]'
}

/** Log seguro: nunca imprime o token/Bearer/URL-com-token nem base64 de mídia. */
function logWhapiRequest({ method, endpoint, token, responseStatus, responseData, responseText }) {
  const hasResponseError =
    Number(responseStatus) >= 400 ||
    (responseData && typeof responseData === 'object' && responseData.error && !isFalse(responseData.error))
  if (!WHATSAPP_DEBUG && !hasResponseError) return
  console.log(JSON.stringify({
    '[WHAPI REQUEST]': { method, endpoint, auth: `Bearer ${maskToken(token)}` },
    '[WHAPI RESPONSE]': {
      status: responseStatus,
      data: responseData != null ? truncateForLog(JSON.stringify(responseData), 1000) : null,
      text: responseText != null ? truncateForLog(responseText, 500) : null,
    },
  }, null, 2))
}

function isFalse(v) {
  return v === false || v === 'false'
}

function createFetchOptions(method, body) {
  let signal
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(WHAPI_TIMEOUT_MS)
    }
  } catch { /* Node < 17.3 */ }
  const opts = {
    method,
    headers: { accept: 'application/json' },
    ...(signal && { signal }),
  }
  const m = String(method || 'GET').toUpperCase()
  if (body != null && m !== 'GET' && m !== 'HEAD') {
    opts.headers = { ...opts.headers, 'Content-Type': 'application/json' }
    opts.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return opts
}

/** Injeta o Bearer nos headers (nunca na URL/query). */
function withAuth(headers, token) {
  return { ...headers, Authorization: `Bearer ${String(token || '').trim()}` }
}

/**
 * POST/PUT/PATCH JSON. Mensagens usam send guard + retry só-conexão.
 * `skipSendGuard: true` para upload de arquivo e PATCH /settings (não dispara WhatsApp).
 */
async function sendJson({
  method = 'POST',
  token,
  endpoint,
  body,
  companyId = null,
  meta = null,
  whatsappInstanceId = null,
  skipSendGuard = false,
}) {
  const verb = String(method || 'POST').toUpperCase()
  const url = `${buildBaseUrl()}${endpoint}`
  const fetchOpts = createFetchOptions(verb, body)
  fetchOpts.headers = withAuth(fetchOpts.headers, token)
  const guard = skipSendGuard
    ? null
    : await beforeWhatsAppSend({ companyId, endpoint, body, meta, whatsappInstanceId })
  const startedAt = Date.now()
  try {
    const res = await fetchWithRetry(url, fetchOpts, { maxAttempts: 3, retryConnectionErrors: true })
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    logWhapiRequest({ method: verb, endpoint, token, responseStatus: res.status, responseData: data, responseText: text })
    if (!skipSendGuard) {
      afterWhatsAppSend({
        guard, companyId, endpoint, body, meta, whatsappInstanceId,
        ok: res.ok, status: res.status, data, text, durationMs: Date.now() - startedAt,
      })
    }
    return { ok: res.ok, status: res.status, data, text }
  } catch (e) {
    if (!skipSendGuard) {
      afterWhatsAppSend({
        guard, companyId, endpoint, body, meta, whatsappInstanceId,
        ok: false, error: e?.message || e, durationMs: Date.now() - startedAt,
      })
    }
    throw e
  }
}

async function post(opts) {
  return sendJson({ ...opts, method: 'POST' })
}

async function put(opts) {
  return sendJson({ ...opts, method: 'PUT' })
}

async function patch(opts) {
  return sendJson({ ...opts, method: 'PATCH' })
}

async function get({ token, endpoint, extraParams = {} }) {
  const sep = String(endpoint || '').includes('?') ? '&' : '?'
  const qs = new URLSearchParams(extraParams).toString()
  const url = `${buildBaseUrl()}${endpoint}${qs ? sep + qs : ''}`
  const fetchOpts = createFetchOptions('GET')
  fetchOpts.headers = withAuth(fetchOpts.headers, token)
  const res = await fetchWithRetry(url, fetchOpts)
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  logWhapiRequest({ method: 'GET', endpoint, token, responseStatus: res.status, responseData: data, responseText: text })
  return { ok: res.ok, status: res.status, data, text }
}

module.exports = {
  buildBaseUrl,
  maskToken,
  maskTokenInLogs,
  validateRequiredFields,
  logWhapiRequest,
  sendJson,
  post,
  put,
  patch,
  get,
}
