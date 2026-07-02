/**
 * Provider UltraMSG (WhatsApp via conexão QR Code).
 * Envio via REST; recebimento via webhook POST /webhooks/ultramsg.
 *
 * Multi-tenant: credenciais vêm da tabela `empresa_zapi` por company_id (nome histórico da migração; ver ../docs/_OFICIAL/ADR-LEGACY-NAMING.md).
 * API: https://api.ultramsg.com/{instance_id}/
 *
 * Formato telefone: +5534999999999 (individual) ou 120363...@g.us (grupo).
 */

const { normalizePhoneBR, toZapiSendFormat, possiblePhonesBR } = require('../../helpers/phoneHelper')
const { invalidateEmpresaWhatsappConfigCache } = require('../whatsappConfigService')
const {
  getDefaultWhatsappInstance,
  getWhatsappInstanceById,
} = require('../whatsappInstanceService')
const { fetchWithRetry } = require('../../helpers/retryWithBackoff')
const {
  beforeWhatsAppSend,
  afterWhatsAppSend,
  buildSendMeta,
} = require('../whatsappSendGuardService')

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
// Delay entre envios: 0 = sem delay (envio imediato). Ex: ULTRAMSG_SEND_DELAY_MS=0 para desativar.
const MIN_DELAY_BETWEEN_SENDS_MS = Math.max(0, Number(process.env.ULTRAMSG_SEND_DELAY_MS) ?? 0)
const BODY_MAX_LEN = 4096
const CAPTION_MAX_LEN = 1024
const FILENAME_MAX_LEN = 255
const CHATS_MESSAGES_LIMIT_MAX = 1000
const OLD_MESSAGES_SYNC_MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.OLD_MESSAGES_SYNC_MAX_PAGES) || 10))
const ULTRAMSG_TIMEOUT_MS = Number(process.env.ULTRAMSG_TIMEOUT_MS) || 30_000
const lastSendPerCompany = new Map()
const LAST_SEND_MAP_MAX = 500
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

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

// ========== Camada centralizada UltraMsg (contrato oficial) ==========

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
function maskTokenInLogs(t) {
  return maskToken(t)
}

/** Normaliza phone/chatId para formato UltraMsg: +55... ou xxx@g.us */
function normalizeChatId(phoneOrChatId) {
  return toUltramsgPhone(phoneOrChatId) || phoneToChatId(phoneOrChatId) || ''
}

/** Valida campos obrigatórios; retorna { valid, error }. */
function validateRequiredFields(obj, required) {
  if (!obj || typeof obj !== 'object') return { valid: false, error: 'payload inválido' }
  const missing = required.filter((k) => obj[k] == null || String(obj[k]).trim() === '')
  if (missing.length) return { valid: false, error: `Campos obrigatórios: ${missing.join(', ')}` }
  return { valid: true }
}

/** Mascara token em logs — nunca expor segredos. */
function maskToken(t) {
  if (!t || typeof t !== 'string') return '***'
  if (t.length <= 4) return '****'
  return t.slice(0, 2) + '***' + t.slice(-2)
}

/** 
 * Converte URL de áudio para formato compatível com UltraMsg.
 * Corrige MIME types problemáticos (webm -> ogg) mantendo o codec opus.
 */
function normalizeAudioUrl(audioUrl) {
  if (!audioUrl || typeof audioUrl !== 'string') return audioUrl
  
  // Se é data URI com webm, converter para ogg (mesmo codec, container compatível)
  if (audioUrl.startsWith('data:audio/webm')) {
    return audioUrl.replace('data:audio/webm', 'data:audio/ogg')
  }
  
  // Se é data URI com opus, converter para ogg
  if (audioUrl.startsWith('data:audio/opus')) {
    return audioUrl.replace('data:audio/opus', 'data:audio/ogg')
  }
  
  return audioUrl
}

function isDataUri(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('data:')
}

function extractAudioExtension(value = '') {
  try {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const withoutQuery = raw.split('?')[0].split('#')[0]
    const match = withoutQuery.match(/\.([a-z0-9]{2,5})$/i)
    return match ? String(match[1]).toLowerCase() : ''
  } catch {
    return ''
  }
}

function isAllowedAudioExtension(ext) {
  if (!ext) return true // URLs de CDN sem extensão explícita
  return ['mp3', 'ogg', 'aac', 'wav', 'm4a', 'opus', 'webm'].includes(String(ext).toLowerCase())
}

function isAllowedAudioEndpointExtension(ext) {
  if (!ext) return true // URLs de CDN da UltraMsg normalmente não têm extensão
  return ['mp3', 'ogg', 'aac'].includes(String(ext).toLowerCase())
}

/**
 * Verifica se o erro do UltraMsg é relacionado a extensão de arquivo não suportada.
 * UltraMsg pode retornar erro como string, objeto ou array de objetos.
 */
function isFileExtensionError(error) {
  if (!error) return false
  
  // Erro como string
  if (typeof error === 'string') {
    return error.includes('file extension not supported')
  }
  
  // Erro como array de objetos
  if (Array.isArray(error)) {
    return error.some(e => {
      if (typeof e === 'string') return e.includes('file extension not supported')
      if (e && typeof e === 'object') {
        return Object.values(e).some(val => 
          typeof val === 'string' && val.includes('file extension not supported')
        )
      }
      return false
    })
  }
  
  // Erro como objeto
  if (typeof error === 'object') {
    return Object.values(error).some(val => 
      typeof val === 'string' && val.includes('file extension not supported')
    )
  }
  
  return false
}

/**
 * Tenta enviar áudio com múltiplos formatos até um funcionar.
 * Usado quando o formato original é rejeitado pelo UltraMsg.
 */
async function tryMultipleAudioFormats(phone, originalAudioUrl, cfg, endpoint = '/messages/audio') {
  if (!originalAudioUrl.startsWith('data:')) return false
  
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length) return false
  
  const base64Data = originalAudioUrl.split(',')[1]
  if (!base64Data) return false
  
  // Lista de MIME types para tentar, em ordem de compatibilidade
  const mimeTypesToTry = [
    'audio/mpeg',  // MP3 - mais universalmente aceito
    'audio/ogg',   // OGG - boa compatibilidade
    'audio/wav',   // WAV - formato básico
    'audio/mp4',   // M4A/AAC em container MP4
    'audio/aac'    // AAC puro
  ]
  
  for (const mimeType of mimeTypesToTry) {
    try {
      const audioUrl = `data:${mimeType};base64,${base64Data}`
      const body = { to: nums[0], audio: audioUrl }
      
      const result = await postJson({
        ...cfg,
        endpoint,
        body,
        meta: buildSendMeta('audio_format_retry', nums[0], { companyId: cfg.companyId }),
      })
      const hasError = result.data?.error && result.data.error !== false && result.data.error !== 'false'
      const sentFailed = result.data?.sent === 'false' || result.data?.sent === false
      
      if (result.ok && !hasError && !sentFailed) {
        console.log(`✅ UltraMsg áudio enviado como ${mimeType}:`, nums[0]?.slice(-12))
        return true
      }
      
      // Se ainda é erro de extensão, continua tentando
      if (isFileExtensionError(result.data?.error)) {
        console.log(`[ULTRAMSG] ${mimeType} também rejeitado, tentando próximo formato`)
        continue
      }
      
      // Se é outro tipo de erro, para de tentar
      console.warn(`[ULTRAMSG] Erro não relacionado à extensão com ${mimeType}:`, result.data?.error)
      break
      
    } catch (error) {
      console.warn(`[ULTRAMSG] Erro ao tentar ${mimeType}:`, error?.message)
      continue
    }
  }
  
  return false
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

async function awaitSendDelay(companyId, opts = {}) {
  if (MIN_DELAY_BETWEEN_SENDS_MS <= 0) return
  const key = companyId ?? 'default'
  if (opts?.skipProviderDelay) {
    lastSendPerCompany.set(key, Date.now())
    if (lastSendPerCompany.size > LAST_SEND_MAP_MAX) {
      const oldest = lastSendPerCompany.keys().next().value
      lastSendPerCompany.delete(oldest)
    }
    return
  }
  const last = lastSendPerCompany.get(key) || 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_DELAY_BETWEEN_SENDS_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_BETWEEN_SENDS_MS - elapsed))
  }
  lastSendPerCompany.set(key, Date.now())
  if (lastSendPerCompany.size > LAST_SEND_MAP_MAX) {
    const oldest = lastSendPerCompany.keys().next().value
    lastSendPerCompany.delete(oldest)
  }
}

/**
 * Resolve config (basePath, token) para chamadas à UltraMsg.
 * @param {{ companyId?: number }} [opts]
 */
async function resolveConfig(opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (companyId == null || companyId === '') return null
  const cid = Number(companyId)
  const whatsappInstanceId = opts?.whatsappInstanceId ?? opts?.whatsapp_instance_id
  const resolved = whatsappInstanceId
    ? await getWhatsappInstanceById(cid, whatsappInstanceId, { includeCredentials: true, requireActive: true })
    : await getDefaultWhatsappInstance(cid, { includeCredentials: true })
  const instance = resolved.instance
  const config = instance
  const error = resolved.error
  if (resolved.error || !instance) {
    console.warn(`[ULTRAMSG] Empresa ${companyId} sem instancia WhatsApp configurada.`, error || 'config vazio')
    return null
  }
  const instanceId = String(config.instance_id || '').trim()
  const token = String(config.instance_token || '').trim()
  if (!instanceId || !token) return null
  const segment = instanceId.toLowerCase().startsWith('instance') ? instanceId : `instance${instanceId}`
  const basePath = `${ULTRAMSG_BASE_URL}/${encodeURIComponent(segment)}`
  return {
    basePath,
    token,
    instanceId: segment,
    companyId: cid,
    whatsappInstanceId: instance.id ?? null,
    provider: instance.provider || 'ultramsg',
  }
}

/**
 * Converte número para formato UltraMsg: +5511986459364 (13 dígitos BR), 120...@g.us ou {Group}-{Owner}@g.us.
 * UltraMsg exige DDI 55 completo. Prioriza normalizePhoneBR + toZapiSendFormat para garantir 13 dígitos (celular).
 */
function toUltramsgPhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return s.replace(/-group$/, '') + '@g.us'
  // Formato UltraMsg Group-Owner sem sufixo (ex: 3618420-5534984080098)
  if (/^\d{5,15}-\d{10,15}$/.test(s)) return `${s}@g.us`
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  // Normaliza BR (55 + DDD + número) e garante 13 dígitos para celular (toZapiSendFormat insere 9 se 12)
  const norm = normalizePhoneBR(s)
  const fmt = toZapiSendFormat(norm || digits) || (digits.startsWith('55') ? digits : '55' + digits)
  return fmt ? `+${fmt}` : ''
}

/** Candidatos de telefone para envio (individual e grupo). */
function phoneCandidatesForSend(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return []
  const list = []
  const main = toUltramsgPhone(raw)
  if (main) list.push(main)
  if (raw.endsWith('@g.us') && !main.includes('@')) list.push(raw)
  if (raw.includes('-group')) list.push(raw.replace(/-group$/, '') + '@g.us')
  return Array.from(new Set(list.filter(Boolean)))
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

async function post({ basePath, token, endpoint, body, companyId = null, meta = null }) {
  const url = `${basePath}${endpoint}`
  const payload = appendToken(body || {}, token)
  const fetchOpts = createFetchOptions('POST', payload)
  const guard = await beforeWhatsAppSend({ companyId, endpoint, body, meta })
  const startedAt = Date.now()
  let res
  let text = ''
  let data = null
  try {
    res = await fetchWithRetry(url, fetchOpts, { maxAttempts: 1 })
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
async function postJson({ basePath, token, endpoint, body, companyId = null, meta = null }) {
  return post({ basePath, token, endpoint, body, companyId, meta })
}

async function getJson({ basePath, token, endpoint, extraParams = {}, companyId = null }) {
  return get({ basePath, token, endpoint, extraParams, companyId })
}

/** Normaliza telefone (interface compatível com zapi). */
function normalizePhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return s
  return normalizePhoneBR(s)
}

function phoneCandidatesForLookup(phone) {
  const norm = normalizePhone(phone)
  const candidates = possiblePhonesBR(norm)
  const sendFmt = toZapiSendFormat(norm)
  if (sendFmt) candidates.push(sendFmt)
  return Array.from(new Set(candidates.filter(Boolean)))
}

function oldMessagesDebugEnabled(opts = {}) {
  return opts?.debugOldMessages === true ||
    String(process.env.OLD_MESSAGES_SYNC_DEBUG || '').trim() === '1' ||
    String(process.env.WHATSAPP_DEBUG || '').trim() === '1'
}

function safeChatIdTail(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.length <= 14 ? raw : `...${raw.slice(-14)}`
}

function oldProviderMessageId(message) {
  const values = [
    message?.messageId,
    message?.zaapId,
    message?.id,
    message?.msgId,
    message?.message_id,
    message?.key?.id,
  ]
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function pushUniqueValue(list, value) {
  const raw = String(value || '').trim()
  if (raw && !list.includes(raw)) list.push(raw)
}

function chatMessageCandidatesForLookup(phone, opts = {}) {
  const values = [phone]
  if (Array.isArray(opts.chatIdCandidates)) values.push(...opts.chatIdCandidates)

  const candidates = []
  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw) continue

    if (raw.endsWith('@g.us') || raw.endsWith('@c.us')) pushUniqueValue(candidates, raw)
    if (/@s\.whatsapp\.net$/i.test(raw)) {
      pushUniqueValue(candidates, raw.replace(/@s\.whatsapp\.net$/i, '@c.us'))
    }

    pushUniqueValue(candidates, toChatIdForChats(raw) || phoneToChatId(raw))
    for (const candidate of phoneCandidatesForLookup(raw)) {
      pushUniqueValue(candidates, phoneToChatId(candidate))
    }
  }

  return candidates.filter(Boolean)
}

/**
 * Envia mensagem de texto.
 */
async function sendText(phone, message, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  await awaitSendDelay(companyId, opts)
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância UltraMsg não configurada. Conecte o WhatsApp no painel de integrações.' }
  }
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !message) {
    return { ok: false, messageId: null, error: 'Número inválido ou mensagem vazia.' }
  }
  const msg = String(message).trim()
  if (msg.length > BODY_MAX_LEN) {
    return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }
  }
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  const body = { to: nums[0], body: msg }
  if (replyMessageId) body.msgId = replyMessageId
  const referenceId = opts?.referenceId ? String(opts.referenceId).trim().slice(0, 200) : null
  if (referenceId) body.referenceId = referenceId

  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/chat',
    body,
    meta: buildSendMeta('text', nums[0], opts, { textLength: msg.length }),
  })
  // UltraMsg retorna HTTP 200 mesmo em caso de erro (ex.: token inválido) — checar body também
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const bodyError = !normalized.ok
  if (!ok || bodyError) {
    let errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    if (ultramsgResponseIndicatesBadInstanceToken(data, text)) {
      errMsg += ` — Atualize instance_token em empresa_zapi (token atual do painel UltraMSG, company_id=${cfg.companyId}).`
    }
    console.warn('❌ UltraMsg sendText falhou:', nums[0]?.slice(-12), status, errMsg.slice(0, 200), '| token:', maskToken(cfg.token))
    return { ...normalized, ok: false, error: errMsg }
  }
  const msgId = normalized.messageId
  const numLog = nums[0] ? (String(nums[0]).replace(/\D/g, '').length >= 13 ? String(nums[0]).slice(-13) : String(nums[0]).slice(-12)) : ''
  console.log('✅ UltraMsg mensagem enviada:', numLog || nums[0], msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return normalized
}

/**
 * Envia link enriquecido (fallback: sendText com URL para preview automático).
 */
async function sendLink(phone, payload, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id, opts)
  const linkUrl = String(payload?.linkUrl || '').trim()
  const title = String(payload?.title || '').trim()
  const desc = String(payload?.linkDescription || '').trim()
  const msg = String(payload?.message || '').trim() || `${title}\n${desc}\n${linkUrl}`
  return sendText(phone, msg, opts)
}

/**
 * Envia imagem por URL.
 */
async function sendImage(phone, url, caption = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL da imagem inválido' } : false
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = { to: nums[0], image: String(url).trim() }
  if (captionTrim) body.caption = captionTrim
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/image',
    body,
    meta: buildSendMeta('image', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    console.warn('❌ UltraMsg sendImage falhou:', nums[0]?.slice(-12), String(text || data?.error || '').slice(0, 150), '| token:', maskToken(cfg.token))
    return returnDetails ? normalized : false
  }
  console.log('✅ UltraMsg imagem enviada:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia áudio por URL.
 * UltraMsg aceita: mp3, aac, ogg | máx 16 MB | link HTTP ou base64
 */
async function sendAudio(phone, audioUrl, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return returnDetails ? { ok: false, error: 'Destino ou áudio inválido' } : false
  
  // Processa URL de áudio para melhor compatibilidade
  const processedAudioUrl = normalizeAudioUrl(String(audioUrl).trim())
  const audioExt = extractAudioExtension(opts?.audioMeta?.originalName || processedAudioUrl)
  const audioMime = String(opts?.audioMeta?.mimeType || '').toLowerCase()

  if (isDataUri(processedAudioUrl)) {
    const reason = 'Data URI não suportado para /messages/audio; envie URL HTTP(S).'
    console.warn('[ULTRAMSG][AUDIO] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: 'data:*base64*' },
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioExtension(audioExt)) {
    const reason = `Extensão de áudio não suportada para UltraMsg: .${audioExt}`
    console.warn('[ULTRAMSG][AUDIO] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioEndpointExtension(audioExt)) {
    const reason = `Extensão .${audioExt} não suportada no endpoint /messages/audio`
    console.warn('[ULTRAMSG][AUDIO] Formato não aceito em /messages/audio, tentando /messages/voice:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    const allowVoiceFallback = opts?.allowVoiceFallback !== false
    if (!allowVoiceFallback) {
      return returnDetails
        ? { ok: false, error: `${reason}. Permitidos em /messages/audio: mp3/ogg/aac.` }
        : false
    }
    const voiceResult = await sendVoice(phone, processedAudioUrl, {
      ...opts,
      returnDetails: true,
      // Evita esperar delay duas vezes no fallback audio -> voice
      skipProviderDelay: true,
      // Evita "ping-pong" de fallback voice -> audio
      disableAudioFallback: true,
      allowVoiceFallback: false
    })
    if (voiceResult?.ok) {
      return returnDetails
        ? { ok: true, messageId: voiceResult?.messageId ?? null, error: null }
        : true
    }
    const voiceError = String(voiceResult?.error || 'Falha ao enviar via /messages/voice')
    return returnDetails ? { ok: false, error: `${reason}; fallback voice falhou: ${voiceError}` } : false
  }
  
  console.log(`[ULTRAMSG] Tentando enviar audio para ${nums[0]?.slice(-12)} com URL: ${processedAudioUrl.slice(0, 50)}...`)
  const body = { to: nums[0], audio: processedAudioUrl }
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/audio',
    body,
    meta: buildSendMeta('audio', nums[0], opts),
  })
  
  // UltraMsg pode responder HTTP 200 com erro no body ou sem aceite explícito.
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const explicitError = data?.error && data.error !== false && data.error !== 'false'
  const sentFailed = data?.sent === 'false' || data?.sent === false
  
  // Verifica se é erro de extensão não suportada
  const isExtensionError = isFileExtensionError(data?.error)
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] sendAudio tentativa:', {
      endpoint: '/messages/audio',
      to: nums[0],
      audio: processedAudioUrl.slice(0, 120),
      ext: audioExt || null,
      mime: audioMime || null,
      result: { ok, status, hasError: !!explicitError, sentFailed, isExtensionError },
    })
  }
  
  if (!normalized.ok) {
    const errRaw = normalized.error || data?.error || (sentFailed ? 'sent:false' : null) || String(text || '').slice(0, 200) || `HTTP ${status}`
    const errMsg = typeof errRaw === 'object' ? JSON.stringify(errRaw) : String(errRaw)
    console.warn('❌ UltraMsg sendAudio falhou:', {
      to: nums[0]?.slice(-12),
      endpoint: '/messages/audio',
      status,
      error: errMsg.slice(0, 300),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
      response: { data: data || null, text: String(text || '').slice(0, 300) },
      token: maskToken(cfg.token),
    })
    return returnDetails ? { ...normalized, ok: false, error: errMsg } : false
  }
  console.log('✅ UltraMsg áudio enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia documento por URL.
 */
async function sendFile(phone, url, fileName = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL do documento inválido' } : false
  }
  const ext = fileName ? String(fileName).split('.').pop() : 'pdf'
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'pdf'
  const filenameRaw = fileName ? String(fileName).trim() : `file.${safeExt}`
  const filename = filenameRaw.slice(0, FILENAME_MAX_LEN)
  const captionTrim = String(opts?.caption || '').trim().slice(0, CAPTION_MAX_LEN)
  // UltraMsg exige caption no POST /messages/document (vazio falha o envio).
  // Não usar o nome do arquivo como legenda visível no WhatsApp.
  const captionForApi = captionTrim || ' '
  const body = { to: nums[0], document: String(url).trim(), filename, caption: captionForApi }
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/document',
    body,
    meta: buildSendMeta('file', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    let errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    if (isFileExtensionError(errMsg) || isFileExtensionError(data?.error)) {
      errMsg = `Extensão não suportada pelo WhatsApp (.${safeExt}). Tente ZIP, PDF ou outro formato.`
    }
    console.warn('❌ UltraMsg sendFile falhou:', nums[0]?.slice(-12), filename?.slice(-40), errMsg.slice(0, 200))
    return returnDetails ? { ok: false, messageId: null, error: errMsg } : false
  }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg arquivo enviado:', nums[0]?.slice(-12), filename?.slice(-30))
  return returnDetails ? { ok: true, messageId: msgId ? String(msgId) : null, error: null } : true
}

/**
 * Envia vídeo por URL.
 */
async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !videoUrl) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL do vídeo inválido' } : false
  }
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = { to: nums[0], video: String(videoUrl).trim() }
  if (captionTrim) body.caption = captionTrim
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/video',
    body,
    meta: buildSendMeta('video', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    const errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    console.warn('❌ UltraMsg sendVideo falhou:', nums[0]?.slice(-12), errMsg.slice(0, 200))
    return returnDetails ? { ok: false, messageId: null, error: errMsg } : false
  }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg vídeo enviado:', nums[0]?.slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return returnDetails ? { ok: true, messageId: msgId ? String(msgId) : null, error: null } : true
}

/**
 * Envia figurinha (sticker) por URL.
 */
async function sendSticker(phone, sticker, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !sticker) return returnDetails ? { ok: false, messageId: null, error: 'Destino ou sticker inválido' } : false
  const body = { to: nums[0], sticker: String(sticker).trim() }
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/sticker',
    body,
    meta: buildSendMeta('sticker', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return returnDetails ? normalized : false
  console.log('✅ UltraMsg sticker enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia reação a uma mensagem.
 * UltraMsg: msgId, emoji. O chat é inferido pelo msgId.
 */
async function sendReaction(phone, messageId, reaction, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  const emoji = String(reaction || '').trim()
  if (!mid || !emoji) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length) return false
  const body = { msgId: mid, emoji }
  const { ok } = await postJson({
    ...cfg,
    endpoint: '/messages/reaction',
    body,
    meta: buildSendMeta('reaction', nums[0], opts),
  })
  return ok
}

/**
 * Remove reação. UltraMsg não tem endpoint dedicado — envia reação vazia se suportado.
 */
async function removeReaction(phone, messageId, opts = {}) {
  return sendReaction(phone, messageId, '', opts)
}

/**
 * Envia áudio de voz (voice note). UltraMsg exige codec opus.
 * POST /{instance_id}/messages/voice — body: token, to, audio
 * Fallback: se o endpoint voice rejeitar (ex.: formato), tenta /messages/audio.
 */
async function sendVoice(phone, audioUrl, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return returnDetails ? { ok: false, error: 'Destino ou áudio inválido' } : false
  
  // Processa URL de áudio para melhor compatibilidade
  const processedAudioUrl = normalizeAudioUrl(String(audioUrl).trim())
  const audioExt = extractAudioExtension(opts?.audioMeta?.originalName || processedAudioUrl)
  const audioMime = String(opts?.audioMeta?.mimeType || '').toLowerCase()

  if (isDataUri(processedAudioUrl)) {
    const reason = 'Data URI não suportado para /messages/voice; envie URL HTTP(S).'
    console.warn('[ULTRAMSG][VOICE] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: 'data:*base64*' },
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  if (!isAllowedAudioExtension(audioExt)) {
    const reason = `Extensão de áudio não suportada para UltraMsg: .${audioExt}`
    console.warn('[ULTRAMSG][VOICE] Rejeitado antes do POST:', {
      reason,
      to: nums[0]?.slice(-12),
      ext: audioExt,
      mime: audioMime || null,
      url: processedAudioUrl.slice(0, 120),
    })
    return returnDetails ? { ok: false, error: reason } : false
  }
  
  const body = { to: nums[0], audio: processedAudioUrl }

  // Tenta endpoint voice primeiro
  console.log(`[ULTRAMSG] Tentando enviar voice para ${nums[0]?.slice(-12)} com URL: ${processedAudioUrl.slice(0, 50)}...`)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/voice',
    body,
    meta: buildSendMeta('voice', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const explicitError = data?.error && data.error !== false && data.error !== 'false'
  const sentFailed = data?.sent === 'false' || data?.sent === false
  
  // Verifica se é erro de extensão não suportada
  const isExtensionError = isFileExtensionError(data?.error)
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] sendVoice tentativa:', {
      endpoint: '/messages/voice',
      to: nums[0],
      audio: processedAudioUrl.slice(0, 120),
      ext: audioExt || null,
      mime: audioMime || null,
      result: { ok, status, hasError: !!explicitError, sentFailed, isExtensionError },
    })
  }
  
  if (!normalized.ok) {
    const errRaw = normalized.error || data?.error || (sentFailed ? 'sent:false' : null) || String(text || '').slice(0, 200) || `HTTP ${status}`
    const errMsg = typeof errRaw === 'object' ? JSON.stringify(errRaw) : String(errRaw)
    console.warn('❌ UltraMsg sendVoice falhou, tentando /messages/audio:', {
      to: nums[0]?.slice(-12),
      endpoint: '/messages/voice',
      status,
      error: errMsg.slice(0, 300),
      ext: audioExt || null,
      mime: audioMime || null,
      payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
      response: { data: data || null, text: String(text || '').slice(0, 300) },
      token: maskToken(cfg.token),
    })

    if (opts?.disableAudioFallback) {
      return returnDetails ? { ...normalized, ok: false, error: errMsg } : false
    }

    // Fallback: tenta como áudio comum
    const fb = await postJson({
      ...cfg,
      endpoint: '/messages/audio',
      body,
      meta: buildSendMeta('voice_audio_fallback', nums[0], opts),
    })
    const fbNormalized = normalizeUltraMsgSendResult({
      httpOk: fb.ok,
      status: fb.status,
      data: fb.data,
      text: fb.text,
      fallbackError: fb.data?.message,
    })
    const fbExplicitError = fb.data?.error && fb.data.error !== false && fb.data.error !== 'false'
    const fbSentFailed = fb.data?.sent === 'false' || fb.data?.sent === false
    
    // Verifica se o fallback também tem erro de extensão
    const fbIsExtensionError = isFileExtensionError(fb.data?.error)
    
    if (!fbNormalized.ok) {
      const fbErrRaw = fbNormalized.error || fb.data?.error || (fbSentFailed ? 'sent:false' : null) || String(fb.text || '').slice(0, 200) || `HTTP ${fb.status}`
      const fbErrMsg = typeof fbErrRaw === 'object' ? JSON.stringify(fbErrRaw) : String(fbErrRaw)
      console.warn('❌ UltraMsg sendAudio (fallback) falhou:', {
        to: nums[0]?.slice(-12),
        endpoint: '/messages/audio',
        status: fb.status,
        error: fbErrMsg.slice(0, 300),
        ext: audioExt || null,
        mime: audioMime || null,
        payload: { to: nums[0], audio: processedAudioUrl.slice(0, 120) },
        response: { data: fb.data || null, text: String(fb.text || '').slice(0, 300) },
        isExtensionError: fbIsExtensionError || isExtensionError,
        token: maskToken(cfg.token),
      })
      return returnDetails ? { ...fbNormalized, ok: false, error: fbErrMsg } : false
    }
    console.log('✅ UltraMsg áudio enviado (fallback /messages/audio):', nums[0]?.slice(-12))
    return returnDetails ? fbNormalized : true
  }
  console.log('✅ UltraMsg voice enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia localização.
 * POST /{instance_id}/messages/location — body: token, to, address, lat, lng
 * address: até 2 linhas com \n; máx 300 chars
 */
async function sendLocation(phone, { address = '', lat, lng }, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const nums = phoneCandidatesForSend(phone)
  const addr = String(address || '').slice(0, 300)
  const latitude = Number(lat)
  const longitude = Number(lng)
  if (!nums.length || (isNaN(latitude) && isNaN(longitude))) return { ok: false, messageId: null }
  const body = { to: nums[0], address: addr, lat: latitude, lng: longitude }
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/location',
    body,
    meta: buildSendMeta('location', nums[0], opts, { textLength: addr.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return { ...normalized, ok: false }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg localização enviada:', nums[0]?.slice(-12))
  return normalized
}

/**
 * Deleta mensagem no WhatsApp. msgId deve vir do webhook.
 * POST /{instance_id}/messages/delete — body: token, msgId
 */
async function deleteMessage(phone, msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(msgId || '').trim()
  if (!mid) return false
  const body = { msgId: mid }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/delete', body })
  return ok
}

/**
 * Reenvia mensagens por status (unsent ou expired).
 * POST /{instance_id}/messages/resendByStatus — body: token, status
 */
async function resendByStatus(status, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const s = String(status || '').toLowerCase()
  if (!['unsent', 'expired'].includes(s)) return { ok: false, error: 'status deve ser unsent ou expired' }
  const body = { status: s }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/resendByStatus', body })
  return { ok, data, text }
}

/**
 * Reenvia mensagem por id.
 * POST /{instance_id}/messages/resendById — body: token, id
 */
async function resendById(msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const mid = String(msgId || '').trim()
  if (!mid) return { ok: false, error: 'msgId obrigatório' }
  const body = { id: mid }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/resendById', body })
  return { ok, data, text }
}

/**
 * Limpa mensagens por status (queue, sent, unsent, invalid).
 * POST /{instance_id}/messages/clear — body: token, status
 */
async function clearMessages(status, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const s = String(status || '').toLowerCase()
  if (!['queue', 'sent', 'unsent', 'invalid'].includes(s)) return { ok: false, error: 'status inválido' }
  const body = { status: s }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/clear', body })
  return { ok, data, text }
}

/**
 * Estatísticas de mensagens (sent, queue, unsent).
 * GET /{instance_id}/messages/statistics
 */
async function getMessagesStatistics(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const { ok, data } = await getJson({ ...cfg, endpoint: '/messages/statistics' })
  if (!ok) return null
  return data
}

/**
 * Lista mensagens enviadas via API UltraMsg.
 * GET /{instance_id}/messages — page, limit (máx 100), status (all|queue|sent|unsent|invalid|expired), sort (asc|desc)
 */
async function getMessages(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, data: [], error: 'Instância não configurada' }
  const page = Math.max(1, Number(opts.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 100))
  const status = String(opts.status || 'all').toLowerCase()
  const sort = ['asc', 'desc'].includes(String(opts.sort || '').toLowerCase()) ? opts.sort : 'desc'
  const validStatus = ['all', 'queue', 'sent', 'unsent', 'invalid', 'expired']
  const extraParams = { page: String(page), limit: String(limit), sort }
  if (validStatus.includes(status) && status !== 'all') extraParams.status = status
  const referenceId = opts?.referenceId != null ? String(opts.referenceId).trim() : ''
  const providerId = opts?.id != null ? String(opts.id).trim() : ''
  const from = opts?.from != null ? String(opts.from).trim() : ''
  const to = opts?.to != null ? String(opts.to).trim() : ''
  if (referenceId) extraParams.referenceId = referenceId
  if (providerId) extraParams.id = providerId
  if (from) extraParams.from = from
  if (to) extraParams.to = to

  const { ok, data, text } = await getJson({ ...cfg, endpoint: '/messages', extraParams })
  if (!ok) {
    const err = data?.error || data?.message || text?.slice(0, 200) || `HTTP error`
    return { ok: false, data: [], error: err }
  }
  const list = Array.isArray(data) ? data : (data?.messages ?? data?.data ?? [])
  return { ok: true, data: list }
}

/**
 * Compartilha contato via vCard.
 */
async function sendContact(phone, contactName, contactPhone, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const nums = phoneCandidatesForSend(phone)
  const name = String(contactName || '').trim()
  const contact = String(contactPhone || '').replace(/\D/g, '')
  if (!nums.length || !name || !contact) return { ok: false, messageId: null }
  const tel = contact.startsWith('55') ? contact : `55${contact}`
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${name};;;\nFN:${name}\nTEL;TYPE=CELL;waid=${tel}:+${tel}\nEND:VCARD`
  const body = { to: nums[0], vcard }
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/vcard',
    body,
    meta: buildSendMeta('contact', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return { ...normalized, ok: false }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg contato enviado:', nums[0]?.slice(-12))
  return normalized
}

/**
 * Envia ligação simulada. UltraMsg não possui endpoint — stub.
 */
async function sendCall(phone, callDuration, opts = {}) {
  console.warn('[ULTRAMSG] sendCall não suportado pela API UltraMsg.')
  return { ok: false, messageId: null }
}

/**
 * Extrai array de contatos da resposta UltraMsg (suporta múltiplos formatos).
 */
function parseContactsResponse(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.contacts)) return data.contacts
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.contact)) return data.contact
  return []
}

/**
 * Chunk alto para pedir toda a agenda em uma única chamada.
 * A UltraMsg retorna a lista inteira da instância de uma só vez (sem paginação real).
 * Usar um valor grande garante que o limit da API nunca corte a lista.
 */
const CONTACTS_API_CHUNK_MAX = 10000

/**
 * Lista contatos salvos na agenda do celular conectado via QR.
 * UltraMsg: GET /{instance_id}/contacts — retorna APENAS da instância conectada.
 *
 * Estratégia: página 1 sem parâmetros (API retorna tudo de uma vez).
 * Páginas seguintes com limit+offset caso a API suporte e o chunk anterior tenha chegado ao limite.
 *
 * @returns {{ data: object[], hasMore: boolean, rawCount: number }}
 */
async function getContacts(page = 1, pageSize = CONTACTS_API_CHUNK_MAX, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { data: [], hasMore: false, rawCount: 0 }
  }
  const limit = Math.min(CONTACTS_API_CHUNK_MAX, Math.max(100, Number(pageSize) || CONTACTS_API_CHUNK_MAX))
  const offset = (Math.max(1, Number(page)) - 1) * limit

  const tryFetch = async (extraParams) => {
    const { ok, data } = await getJson({
      ...cfg,
      endpoint: '/contacts',
      extraParams: { ...extraParams }
    })
    if (!ok) return []
    return parseContactsResponse(data)
  }

  try {
    // Sempre envia limit para garantir que o UltraMsg não aplique um teto padrão interno.
    // Offset 0 na página 1; offset calculado nas páginas seguintes (caso a API pagine).
    let raw
    if (page === 1) {
      raw = await tryFetch({ limit: String(limit), offset: '0' })
      // Alguns servidores UltraMsg ignoram params e devolvem tudo; outros respeitam o limit.
      // Se recebemos 0, tenta sem params como último recurso.
      if (raw.length === 0) {
        raw = await tryFetch({})
      }
    } else {
      raw = await tryFetch({ limit: String(limit), offset: String(offset) })
    }

    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getContacts', { page, limit, offset, rawTotal: raw.length })
    }

    const contacts = []
    for (const c of raw) {
      const phoneRaw = String(c.id || c.phone || c.wa_id || '').trim()
      // Ignorar grupos, broadcasts e IDs inválidos
      if (!phoneRaw || phoneRaw.endsWith('@g.us') || phoneRaw.endsWith('@broadcast')) continue
      // Exigir name: apenas contatos salvos na agenda têm este campo preenchido
      if (!c.name || !String(c.name).trim()) continue

      const digits = phoneRaw.replace(/\D/g, '')
      if (!digits || digits.length < 10) continue

      contacts.push({
        phone: phoneRaw,
        name: String(c.name).trim(),
        short: c.short ? String(c.short).trim() : null,
        notify: c.notify ? String(c.notify).trim() : null,
        vname: c.vname ? String(c.vname).trim() : null,
        imgUrl: c.imgUrl || c.photo || null
      })
    }

    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getContacts filtrado:', { total_api: raw.length, com_name: contacts.length })
    }
    // hasMore se a API devolveu exatamente `limit` itens (pode haver mais na próxima página)
    const hasMore = raw.length > 0 && raw.length >= limit
    return { data: contacts, hasMore, rawCount: raw.length }
  } catch (e) {
    if (WHATSAPP_DEBUG) console.warn('[ULTRAMSG] getContacts erro:', e?.message)
    return { data: [], hasMore: false, rawCount: 0 }
  }
}

/** Resolve phone/chatId para chatId no formato @c.us ou @g.us (exigido por chats/*). */
function toChatIdForChats(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return (s.replace(/-group$/, '') || s) + '@g.us'
  return phoneToChatId(s) || ''
}

/**
 * Arquiva chat. UltraMsg: POST /{instance_id}/chats/archive — body: token, chatId
 */
async function archiveChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/archive', body: { chatId } })
  return ok
}

/**
 * Desarquiva chat. UltraMsg: POST /{instance_id}/chats/unarchive — body: token, chatId
 */
async function unarchiveChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/unarchive', body: { chatId } })
  return ok
}

/**
 * Marca chat como lido. UltraMsg: POST /{instance_id}/chats/read — body: token, chatId
 */
async function readChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/read', body: { chatId } })
  return ok
}

/**
 * Limpa mensagens do chat. UltraMsg: POST /{instance_id}/chats/clearMessages
 * Arquitetura pronta; parâmetros conforme doc quando disponível.
 */
async function clearChatMessages(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/clearMessages', body: { chatId } })
  return ok
}

/**
 * Exclui chat. UltraMsg: POST /{instance_id}/chats/delete — body: token, chatId
 * Arquitetura pronta para uso futuro.
 */
async function deleteChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/delete', body: { chatId } })
  return ok
}

/**
 * Lista todos os chats (conversas individuais e grupos).
 * UltraMsg: GET /{instance_id}/chats — retorna lista completa.
 * Aceita resposta como array direto ou objeto com data/chats.
 */
async function getChats(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/chats' })
    if (!ok) return []
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.data ?? data.chats ?? data.list
      if (Array.isArray(arr)) return arr
    }
    return []
  } catch {
    return []
  }
}

/**
 * Lista grupos. UltraMsg: GET /{instance_id}/groups
 * Aceita resposta como array direto ou objeto com data/groups.
 */
async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/groups' })
    if (!ok) return []
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.data ?? data.groups ?? data.chats
      if (Array.isArray(arr)) return arr
    }
    return []
  } catch {
    return []
  }
}

/**
 * Busca detalhes de um grupo. UltraMsg: GET /{instance_id}/groups/group?groupId=XXX
 */
async function getGroup(groupId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !groupId) return null
  try {
    const gid = String(groupId).trim()
    if (!gid || !gid.endsWith('@g.us')) return null
    const { ok, data } = await getJson({ ...cfg, endpoint: '/groups/group', extraParams: { groupId: gid } })
    if (!ok || !data || typeof data !== 'object') return null
    return data
  } catch {
    return null
  }
}

/**
 * Converte phone para chatId no formato WhatsApp: 5511986459364@c.us (13 dígitos BR) ou 120xxx@g.us.
 * UltraMsg exige chatId sem + e sem espaços.
 */
function phoneToChatId(phone) {
  const s = String(phone || '').trim()
  if (!s) return null
  if (s.endsWith('@g.us')) return s
  if (s.endsWith('@c.us')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  const norm = normalizePhoneBR(s)
  const fmt = toZapiSendFormat(norm || digits) || (digits.startsWith('55') ? digits : '55' + digits)
  return fmt ? `${fmt}@c.us` : null
}

// Cache para contatos sem foto (evita requisições repetidas)
const noProfilePictureCache = new Map()
const NO_PICTURE_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 horas

// Rate limiting para requisições de foto de perfil
const profilePictureRateLimit = new Map()
const PROFILE_PICTURE_RATE_LIMIT_MS = 2000 // 2 segundos entre requisições por instância

// Limpeza periódica dos caches (a cada 6 horas)
const cacheCleanupInterval = setInterval(() => {
  const now = Date.now()
  
  // Limpar cache de contatos sem foto expirados
  for (const [key, value] of noProfilePictureCache.entries()) {
    if (value.expiry <= now) {
      noProfilePictureCache.delete(key)
    }
  }
  
  // Limpar rate limit antigo (mais de 1 hora)
  for (const [key, timestamp] of profilePictureRateLimit.entries()) {
    if (now - timestamp > 60 * 60 * 1000) {
      profilePictureRateLimit.delete(key)
    }
  }
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] Cache cleanup completed', {
      noPictureCache: noProfilePictureCache.size,
      rateLimitCache: profilePictureRateLimit.size
    })
  }
}, 6 * 60 * 60 * 1000) // 6 horas
if (cacheCleanupInterval && typeof cacheCleanupInterval.unref === 'function') {
  cacheCleanupInterval.unref()
}

/**
 * Busca URL da foto de perfil.
 * Doc oficial: GET /{instance_id}/contacts/image?token={TOKEN}&chatId={chatId}
 * Parâmetros obrigatórios: token, chatId (ex.: 5511999999999@c.us)
 * Aceita opts.chatId (qualquer formato) ou phone (será convertido para chatId).
 */
async function getProfilePicture(phoneOrChatId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null

  // Usa opts.chatId diretamente se fornecido (qualquer formato válido: @c.us, @g.us, numérico)
  // Caso contrário converte o primeiro argumento para chatId via phoneToChatId
  const rawOpts = opts.chatId ? String(opts.chatId).trim() : null
  const chatId = rawOpts || phoneToChatId(phoneOrChatId)
  if (!chatId) return null

  // Verificar cache de contatos sem foto (por instância e chatId — multi-tenant)
  const cacheKey = `${cfg.instanceId || cfg.companyId || 'default'}:${chatId}`
  const cachedNoPhoto = noProfilePictureCache.get(cacheKey)
  if (cachedNoPhoto && cachedNoPhoto.expiry > Date.now()) {
    // Contato já conhecido por não ter foto, retorna null silenciosamente
    return null
  }

  // Rate limiting por instância para evitar spam de requisições
  const rateLimitKey = `rate_limit:${cfg.instanceId || cfg.companyId || 'default'}`
  const lastRequest = profilePictureRateLimit.get(rateLimitKey)
  const now = Date.now()
  
  if (lastRequest && (now - lastRequest) < PROFILE_PICTURE_RATE_LIMIT_MS) {
    // Muito cedo para nova requisição, aguardar
    const waitTime = PROFILE_PICTURE_RATE_LIMIT_MS - (now - lastRequest)
    await new Promise(resolve => setTimeout(resolve, waitTime))
  }
  
  profilePictureRateLimit.set(rateLimitKey, Date.now())

  try {
    const { ok, data, text } = await get({
      ...cfg,
      endpoint: '/contacts/image',
      extraParams: { chatId }
    })
    
    // Verificar se é erro conhecido de "sem foto"
    const isNoPhotoError = data?.error && (
      data.error.includes("don't have picture") ||
      data.error.includes("not in your chat list") ||
      data.error.includes("user not found")
    )
    
    if (isNoPhotoError) {
      // Cachear que este contato não tem foto
      noProfilePictureCache.set(cacheKey, { expiry: Date.now() + NO_PICTURE_CACHE_TTL })
      
      // Log mais silencioso apenas em debug
      if (WHATSAPP_DEBUG) {
        console.log('[ULTRAMSG] No profile picture:', chatId.slice(-12))
      }
      return null
    }
    
    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getProfilePicture', { chatId: chatId.slice(-12), ok, status: data?.error ?? 'ok' })
    }
    if (!ok) return null
    // Resposta pode ser objeto JSON com URL ou string direta com a URL.
    // UltraMsg retorna: { "success": "https://..." }
    let url = null
    if (data && typeof data === 'object') {
      url = data.success ?? data.url ?? data.image ?? data.img ?? data.profilePicture ?? data.profilePic ?? data.link ?? null
    }
    if (!url && typeof text === 'string' && text.trim().startsWith('http')) url = text.trim()
    return url && typeof url === 'string' ? url.trim() : null
  } catch {
    return null
  }
}

/**
 * Extrai objeto de contato de resposta da API (suporta múltiplos formatos).
 */
function extractContactFromResponse(rawData) {
  if (!rawData || typeof rawData !== 'object') return null
  const candidates = [rawData.contact, rawData.data, rawData]
  for (const c of candidates) {
    if (c && typeof c === 'object' && (c.name != null || c.pushname != null || c.pushName != null || c.notify != null)) {
      return c
    }
  }
  if (rawData.name != null || rawData.pushname != null || rawData.pushName != null || rawData.notify != null) {
    return rawData
  }
  return null
}

/**
 * Metadados do contato. UltraMsg: GET /contacts/contact?chatId=... ou busca em GET /contacts.
 * Retorna: { name, short, notify, vname, imgUrl } para ultramsgSyncContact.
 * Prioridade: name (nome salvo no celular) > pushname (nome de perfil WhatsApp).
 */
async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const chatId = (opts.chatId && String(opts.chatId).trim().endsWith('@c.us'))
    ? String(opts.chatId).trim()
    : phoneToChatId(phone)
  if (!chatId) return null
  const paramNames = ['chatId', 'chatID']
  for (const paramName of paramNames) {
    try {
      const { ok, data: rawData } = await getJson({
        ...cfg,
        endpoint: '/contacts/contact',
        extraParams: { [paramName]: chatId }
      })
      if (WHATSAPP_DEBUG) {
        console.log('[ULTRAMSG] getContactMetadata', { chatId: chatId.slice(-12), paramName, ok, hasData: !!rawData, keys: rawData && typeof rawData === 'object' ? Object.keys(rawData) : [] })
      }
      const data = extractContactFromResponse(rawData)
      if (ok && data) {
        const name = data.name ?? data.formattedName ?? null
        const pushname = data.pushname ?? data.pushName ?? data.notify ?? null
        if (WHATSAPP_DEBUG && (name || pushname)) {
          console.log('[ULTRAMSG] getContactMetadata resultado:', { name: name || '(vazio)', pushname: pushname || '(vazio)' })
        }
        return {
          name: name ? String(name).trim() : null,
          pushname: pushname ? String(pushname).trim() : null,
          short: data.short ? String(data.short).trim() : null,
          notify: pushname ? String(pushname).trim() : null,
          vname: data.vname ? String(data.vname).trim() : null,
          imgUrl: data.imgUrl ?? data.photo ?? data.profilePicture ?? null
        }
      }
    } catch (e) {
      if (WHATSAPP_DEBUG) console.warn('[ULTRAMSG] getContactMetadata erro:', paramName, e?.message)
    }
  }
  try {
    // Fallback: busca em getContacts (lista paginada)
    const digits = String(phone || '').replace(/\D/g, '')
    const searchTail = digits.slice(-8)
    for (let page = 1; page <= 3; page++) {
      const { ok: okList, data: listData } = await getJson({
        ...cfg,
        endpoint: '/contacts',
        extraParams: { limit: '100', offset: String((page - 1) * 100) }
      })
      if (!okList) break
      const arr = Array.isArray(listData) ? listData : (listData?.contacts || [])
      const found = arr.find((c) => {
        const cPhone = String(c.id ?? c.phone ?? c.wa_id ?? '').replace(/\D/g, '')
        return cPhone.endsWith(searchTail) || cPhone === digits
      })
      if (found) {
        const pushname = found.pushname ?? found.pushName ?? found.notify ?? null
        return {
          name: found.name ?? null,
          pushname,
          short: found.short ?? null,
          notify: pushname,
          vname: found.vname ?? null,
          imgUrl: found.imgUrl ?? found.photo ?? null
        }
      }
      if (arr.length < 100) break
    }
    return null
  } catch {
    return null
  }
}

/**
 * Mensagens do chat. UltraMsg: GET /chats/messages (limit obrigatório, max 1000).
 */
async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  const returnDetails = opts?.returnDetails === true
  const endpoint = '/chats/messages'
  const limit = Math.min(CHATS_MESSAGES_LIMIT_MAX, Math.max(1, Number(amount) || 10))
  const debug = oldMessagesDebugEnabled(opts)
  const emptyDetails = (overrides = {}) => ({
    ok: false,
    data: [],
    endpoint,
    limit,
    attempts: [],
    ...overrides,
  })
  if (!cfg) {
    const result = emptyDetails({ error: 'Instancia UltraMsg nao configurada.' })
    return returnDetails ? result : []
  }
  const chatIds = chatMessageCandidatesForLookup(phone, opts)
  if (!chatIds.length) {
    const result = emptyDetails({ error: 'Nenhum chatId valido para consultar mensagens.' })
    return returnDetails ? result : []
  }

  const attempts = []
  let firstEmptyOk = null
  let lastError = null
  try {
    for (const chatId of chatIds) {
      const allData = []
      const seenIds = new Set()
      let cursor = lastMessageId ? String(lastMessageId).trim() : ''
      let chatOk = false
      const maxPages = opts?.fetchAllPages === true ? OLD_MESSAGES_SYNC_MAX_PAGES : 1

      for (let page = 0; page < maxPages; page += 1) {
        let response = null
        try {
          const extraParams = { chatId, limit: String(limit) }
          if (cursor) extraParams.lastMessageId = cursor
          response = await getJson({
            ...cfg,
            endpoint,
            extraParams,
          })
        } catch (e) {
          response = { ok: false, status: null, data: null, text: '', error: e?.message || String(e) }
        }

        const data = Array.isArray(response?.data) ? response.data : []
        const idsInPage = data.map(oldProviderMessageId).filter(Boolean)
        let newInPage = 0
        for (const msg of data) {
          const msgId = oldProviderMessageId(msg)
          if (msgId) {
            if (seenIds.has(msgId)) continue
            seenIds.add(msgId)
          }
          allData.push(msg)
          newInPage += 1
        }

        const attempt = {
          chatIdTail: safeChatIdTail(chatId),
          page: page + 1,
          cursorTail: safeChatIdTail(cursor),
          ok: response?.ok === true,
          status: response?.status ?? null,
          count: data.length,
          newCount: newInPage,
          error: response?.ok === true ? null : String(response?.error || response?.text || response?.status || 'erro na consulta').slice(0, 180),
        }
        attempts.push(attempt)

        if (debug) {
          console.log('[oldMessagesSync][provider] getChatMessages', {
            companyId: opts?.companyId ?? opts?.company_id ?? null,
            endpoint,
            chatIdTail: attempt.chatIdTail,
            page: attempt.page,
            cursorTail: attempt.cursorTail,
            ok: attempt.ok,
            status: attempt.status,
            returned: attempt.count,
            newCount: attempt.newCount,
            error: attempt.error,
          })
        }

        if (response?.ok !== true) {
          lastError = attempt.error || 'Erro ao buscar mensagens antigas.'
          break
        }

        chatOk = true
        if (data.length === 0) break
        if (opts?.fetchAllPages !== true) break
        if (data.length < limit) break
        if (page > 0 && newInPage === 0) break

        const nextCursor = idsInPage[idsInPage.length - 1] || ''
        if (!nextCursor || nextCursor === cursor) break
        cursor = nextCursor
      }

      if (chatOk && allData.length > 0) {
        const result = { ok: true, data: allData, chatId, endpoint, limit, attempts }
        return returnDetails ? result : allData
      }
      if (chatOk) {
        if (!firstEmptyOk) firstEmptyOk = { chatId, data: [] }
        continue
      }
    }

    if (firstEmptyOk) {
      const result = { ok: true, data: [], chatId: firstEmptyOk.chatId, endpoint, limit, attempts }
      return returnDetails ? result : []
    }

    const result = emptyDetails({
      error: lastError || 'Erro ao buscar mensagens antigas.',
      attempts,
    })
    return returnDetails ? result : []
  } catch (e) {
    const result = emptyDetails({
      error: e?.message || 'Erro ao buscar mensagens antigas.',
      attempts,
    })
    return returnDetails ? result : []
  }
}

/**
 * Upload de mídia para UltraMsg. POST /{instance_id}/media/upload
 * Retorna URL pública para usar em sendImage/sendFile/etc quando APP_URL não é acessível.
 */
async function uploadMedia(filePath, filename, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !filePath) return { ok: false, url: null, error: 'Config ou arquivo indisponível' }
  const fs = require('fs')
  const path = require('path')
  if (!fs.existsSync(filePath)) return { ok: false, url: null, error: 'Arquivo não encontrado' }
  const safeFilename = filename || path.basename(filePath) || 'file'
  try {
    const FormData = require('form-data')
    const form = new FormData()
    form.append('token', cfg.token)

    // Não renomear extensão sem transcodificar bytes reais.
    // UltraMsg pode validar conteúdo e extensão; renomear "na marra" tende a falhar.
    let uploadFilename = safeFilename.slice(0, FILENAME_MAX_LEN)

    form.append('file', fs.createReadStream(filePath), { filename: uploadFilename })
    const uploadTimeout = 60_000 // 60s para arquivos até 30MB
    let signal
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(uploadTimeout)
      }
    } catch { /* Node < 17.3 */ }
    const uploadUrl = `${cfg.basePath}/media/upload`
    const uploadHeaders = form.getHeaders()
    const res = await fetchWithRetry(uploadUrl, {
      method: 'POST',
      body: form,
      headers: uploadHeaders,
      ...(signal && { signal })
    }, { maxAttempts: 1 })
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    logUltramsgRequest({
      method: 'POST',
      url: uploadUrl,
      headers: { ...uploadHeaders, token: maskToken(cfg.token) },
      body: { file_original: safeFilename, file_upload: uploadFilename, token: maskToken(cfg.token) },
      responseStatus: res.status,
      responseData: data,
      responseText: text
    })
    if (!res.ok) {
      const err = data?.error || data?.message || `HTTP ${res.status}`
      console.warn('❌ UltraMsg uploadMedia falhou:', safeFilename?.slice(-20), err, '| token:', maskToken(cfg.token))
      return { ok: false, url: null, error: err }
    }
    if (data?.error) {
      const err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
      console.warn('❌ UltraMsg uploadMedia respondeu erro no body:', safeFilename?.slice(-20), err, '| token:', maskToken(cfg.token))
      return { ok: false, url: null, error: err }
    }
    const url = data?.url || data?.link || data?.file || null
    if (!url) {
      const err = data?.message || text?.slice(0, 200) || 'Upload sem URL retornada pela UltraMsg'
      return { ok: false, url: null, error: err }
    }
    return { ok: true, url, error: null }
  } catch (e) {
    console.warn('[ULTRAMSG] uploadMedia:', e?.message || e, '| token:', maskToken(cfg.token))
    return { ok: false, url: null, error: e?.message || 'Erro no upload' }
  }
}

/**
 * Configura webhooks na instância UltraMsg.
 */
async function configureWebhooks(appUrl, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !appUrl) return []
  const base = String(appUrl).replace(/\/$/, '')
  const webhookToken = String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix = webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''
  const webhookUrl = `${base}/webhooks/ultramsg${tokenSuffix}`

  const sendDelay = Math.max(1, Math.min(60, Number(process.env.ULTRAMSG_SEND_DELAY) || 1))
  const sendDelayMax = Math.max(1, Math.min(120, Math.max(sendDelay, Number(process.env.ULTRAMSG_SEND_DELAY_MAX) || 15)))
  // true por padrão: UltraMsg envia URL da mídia no webhook (áudio, imagem, etc.) — essencial para áudios chegarem
  const webhookDownloadMedia = process.env.ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA !== 'false'
  const webhookRetries = Math.max(1, Math.min(5, Number(process.env.ULTRAMSG_WEBHOOK_RETRIES) || 3))
  const body = {
    token: cfg.token,
    webhook_url: webhookUrl,
    webhook_message_received: true,
    webhook_message_create: true,
    webhook_message_ack: true,
    webhook_message_download_media: webhookDownloadMedia,
    webhook_message_reaction: true,
    webhook_retries: webhookRetries,
    sendDelay,
    sendDelayMax
  }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/instance/settings', body })
  if (ok) {
    console.log('✅ UltraMsg webhooks configurados:', webhookUrl)
    return [{ label: 'webhook', ok: true }]
  }
  console.warn('⚠️ UltraMsg configureWebhooks falhou:', String(text || data?.error || '').slice(0, 200), '| token:', maskToken(cfg?.token))
  return [{ label: 'webhook', ok: false }]
}

async function updateProfilePicture(imageUrl, opts = {}) {
  return false
}

async function updateProfileName(name, opts = {}) {
  return false
}

async function updateProfileDescription(description, opts = {}) {
  return false
}

/**
 * Status de conexão da instância.
 */
async function getConnectionStatus(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { connected: false, configured: false }
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/instance/status' })
    if (!ok) return { connected: false, configured: true }
    const status = String(data?.status || data?.state || '').toLowerCase()
    const connected = ['authenticated', 'connected', 'standby'].includes(status) || data?.connected === true
    const phone = data?.phone ?? data?.wid ?? null
    return { connected, configured: true, phone, session: data?.session ?? null }
  } catch (e) {
    console.warn('[ULTRAMSG] getConnectionStatus:', e?.message || e)
    return { connected: false, configured: true }
  }
}

module.exports = {
  sendText,
  sendLink,
  sendImage,
  sendFile,
  sendAudio,
  sendVoice,
  sendVideo,
  sendReaction,
  removeReaction,
  sendContact,
  sendLocation,
  sendCall,
  sendSticker,
  deleteMessage,
  resendByStatus,
  resendById,
  clearMessages,
  getMessagesStatistics,
  getMessages,
  archiveChat,
  unarchiveChat,
  readChat,
  clearChatMessages,
  deleteChat,
  getContacts,
  getChats,
  getGroups,
  getGroup,
  uploadMedia,
  getProfilePicture,
  getContactMetadata,
  getChatMessages,
  configureWebhooks,
  updateProfilePicture,
  updateProfileName,
  updateProfileDescription,
  getConnectionStatus,
  normalizePhone,
  toUltramsgPhone,
  isConfigured: true,
  // Camada centralizada (contrato UltraMsg)
  buildBaseUrl,
  appendToken,
  get,
  post,
  maskTokenInLogs,
  normalizeChatId,
  validateRequiredFields
}
