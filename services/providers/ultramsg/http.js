/**
 * HTTP UltraMSG: form-urlencoded, token mascarado, retry só de conexão no POST de mensagem.
 */

const { fetchWithRetry } = require('../../../helpers/retryWithBackoff')
const {
  beforeWhatsAppSend,
  afterWhatsAppSend,
} = require('../../whatsappSendGuardService')
const { ULTRAMSG_BASE_URL, ULTRAMSG_TIMEOUT_MS, WHATSAPP_DEBUG } = require('./constants')
const { maybeInvalidateCacheOnBadToken } = require('./result')

/** Constrói base URL: https://api.ultramsg.com/instance{id} — UltraMsg exige prefixo "instance" */
function buildBaseUrl(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') return ''
  const id = String(instanceId).trim()
  const segment = id.toLowerCase().startsWith('instance') ? id : `instance${id}`
  return `${ULTRAMSG_BASE_URL}/${encodeURIComponent(segment)}`
}

/** Adiciona token ao body (POST) ou query (GET). */
function appendToken(bodyOrParams, token) {
  if (!bodyOrParams || typeof bodyOrParams !== 'object') return { token }
  return { ...bodyOrParams, token: token || bodyOrParams.token }
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

/** Sanitiza objeto para log (mascara token). */
function sanitizeForLog(obj, token) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'token' && v != null) out[k] = maskToken(token || v)
    else if (typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof URLSearchParams)) out[k] = sanitizeForLog(v, token)
    else out[k] = v
  }
  return out
}

/** Trunca string para log (evita poluir console). */
function truncateForLog(s, maxLen = 500) {
  if (s == null) return s
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...[truncado]'
}

/** Mascara token em string form-urlencoded (token=xxx&...). */
function maskTokenInFormBody(str) {
  if (!str || typeof str !== 'string') return str
  return str.replace(/token=([^&]*)/gi, (_, t) => `token=${maskToken(t)}`)
}

/** Log completo da requisição UltraMsg: URL, headers, params, body e retorno. */
function logUltramsgRequest({ method, url, headers = {}, params = null, body = null, responseStatus, responseData, responseText }) {
  // Verificar se é erro conhecido de foto de perfil para reduzir spam de logs
  const isProfilePictureRequest = url && url.includes('/contacts/image')
  const isKnownProfilePictureError = isProfilePictureRequest && responseData?.error && (
    responseData.error.includes("don't have picture") ||
    responseData.error.includes("not in your chat list") ||
    responseData.error.includes("user not found")
  )

  // Não logar erros conhecidos de foto de perfil, a menos que seja modo debug
  if (isKnownProfilePictureError && !WHATSAPP_DEBUG) {
    return
  }

  const headersObj = typeof headers === 'object' && headers !== null && !Array.isArray(headers)
    ? (headers.get ? Object.fromEntries([...Object.entries(headers)].filter(([k]) => !k.startsWith('_'))) : { ...headers })
    : {}
  const sanitizedHeaders = sanitizeForLog(headersObj)
  let bodyForLog = body
  if (body != null && typeof body === 'string') bodyForLog = maskTokenInFormBody(truncateForLog(body, 800))
  else if (body != null && typeof body === 'object') bodyForLog = sanitizeForLog(body, body?.token)

  const logPayload = {
    '[ULTRAMSG REQUEST]': {
      method,
      url,
      headers: sanitizedHeaders,
      ...(params != null && typeof params === 'object' && Object.keys(params).length > 0 && { params: sanitizeForLog(params, params?.token) }),
      ...(bodyForLog != null && { body: bodyForLog })
    },
    '[ULTRAMSG RESPONSE]': {
      status: responseStatus,
      data: responseData != null ? truncateForLog(JSON.stringify(responseData), 1000) : null,
      text: responseText != null ? truncateForLog(responseText, 500) : null
    }
  }
  const hasResponseError =
    Number(responseStatus) >= 400 ||
    (responseData && typeof responseData === 'object' && responseData.error && responseData.error !== false && responseData.error !== 'false')
  const shouldLogVerbose = WHATSAPP_DEBUG || hasResponseError

  // Log mais compacto para erros conhecidos em modo debug
  if (isKnownProfilePictureError && WHATSAPP_DEBUG) {
    console.log(`[ULTRAMSG] Profile picture not available: ${params?.chatId || 'unknown'}`)
  } else if (shouldLogVerbose) {
    console.log(JSON.stringify(logPayload, null, 2))
  }
}

/**
 * UltraMsg API exige application/x-www-form-urlencoded (não JSON).
 * Ver: https://docs.ultramsg.com/api/post/messages/chat e exemplos PHP/cURL.
 */
function createFetchOptions(method, body, extra = {}) {
  let signal
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(ULTRAMSG_TIMEOUT_MS)
    }
  } catch { /* Node < 17.3 */ }
  const opts = {
    method,
    headers: { accept: 'application/json' },
    ...(signal && { signal }),
    ...extra
  }
  if (body && method === 'POST') {
    opts.headers = { ...opts.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
    if (typeof body === 'string') {
      opts.body = body
    } else if (body && typeof body === 'object') {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(body)) {
        if (v != null && v !== '') params.set(k, String(v))
      }
      opts.body = params.toString()
    }
  }
  return opts
}

/**
 * referenceId (crm-{mensagem_id}) permite localizar o envio depois via GET /messages?referenceId.
 * Sem ele a reconciliacao nao consegue casar o eco do webhook com a mensagem original,
 * e a mensagem fica presa em pending. Suportado pela UltraMsg em chat, image, document, audio e voice.
 */
function aplicarReferenceId(body, opts) {
  const referenceId = opts?.referenceId ? String(opts.referenceId).trim().slice(0, 200) : null
  if (referenceId) body.referenceId = referenceId
  return body
}

async function post({ basePath, token, endpoint, body, companyId = null, meta = null, whatsappInstanceId = null }) {
  const url = `${basePath}${endpoint}`
  const payload = appendToken(body || {}, token)
  const fetchOpts = createFetchOptions('POST', payload)
  // whatsappInstanceId vem do resolveConfig (ja resolvido, inclusive na instancia default),
  // para a guarda espacar envios por numero e nao por empresa.
  const guard = await beforeWhatsAppSend({ companyId, endpoint, body, meta, whatsappInstanceId })
  const startedAt = Date.now()
  let res
  let text = ''
  let data = null
  try {
    // Retry apenas quando a conexao nunca foi estabelecida (DNS/rota/recusa):
    // resposta ou timeout podem significar mensagem ja aceita, e repetir duplicaria no cliente.
    res = await fetchWithRetry(url, fetchOpts, { maxAttempts: 3, retryConnectionErrors: true })
    text = await res.text().catch(() => '')
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    maybeInvalidateCacheOnBadToken(companyId, data, text)
    logUltramsgRequest({
      method: 'POST',
      url,
      headers: fetchOpts.headers || {},
      body: payload,
      responseStatus: res.status,
      responseData: data,
      responseText: text
    })
    afterWhatsAppSend({
      guard,
      companyId,
      endpoint,
      body,
      meta,
      whatsappInstanceId,
      ok: res.ok,
      status: res.status,
      data,
      text,
      durationMs: Date.now() - startedAt,
    })
    return { ok: res.ok, status: res.status, data, text }
  } catch (e) {
    afterWhatsAppSend({
      guard,
      companyId,
      endpoint,
      body,
      meta,
      whatsappInstanceId,
      ok: false,
      error: e?.message || e,
      durationMs: Date.now() - startedAt,
    })
    throw e
  }
}

async function get({ basePath, token, endpoint, extraParams = {}, companyId = null }) {
  const sep = String(endpoint || '').includes('?') ? '&' : '?'
  // UltraMsg exige token como primeiro parâmetro na URL (docs: ?token=xxx&chatId=...)
  const params = { token: String(token || '').trim(), ...extraParams }
  const paramsEncoded = new URLSearchParams(params)
  const url = `${basePath}${endpoint}${sep}${paramsEncoded.toString()}`
  const fetchOpts = createFetchOptions('GET')
  const res = await fetchWithRetry(url, fetchOpts)
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  maybeInvalidateCacheOnBadToken(companyId, data, text)
  logUltramsgRequest({
    method: 'GET',
    url,
    headers: fetchOpts.headers || {},
    params,
    responseStatus: res.status,
    responseData: data,
    responseText: text
  })
  return { ok: res.ok, status: res.status, data, text }
}

/** Alias para compatibilidade interna. */
async function postJson({ basePath, token, endpoint, body, companyId = null, meta = null, whatsappInstanceId = null }) {
  return post({ basePath, token, endpoint, body, companyId, meta, whatsappInstanceId })
}

async function getJson({ basePath, token, endpoint, extraParams = {}, companyId = null }) {
  return get({ basePath, token, endpoint, extraParams, companyId })
}

module.exports = {
  buildBaseUrl,
  appendToken,
  maskToken,
  maskTokenInLogs,
  validateRequiredFields,
  logUltramsgRequest,
  aplicarReferenceId,
  post,
  get,
  postJson,
  getJson,
}
