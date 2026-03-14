/**
 * Provider UltraMsg (WhatsApp via conexão QR Code).
 * Envio via REST; recebimento via webhook POST /webhooks/ultramsg.
 *
 * Multi-tenant: credenciais vêm de empresa_zapi por company_id (mesma tabela).
 * API: https://api.ultramsg.com/{instance_id}/
 *
 * Formato telefone: +5534999999999 (individual) ou 120363...@g.us (grupo).
 */

const { normalizePhoneBR, toZapiSendFormat, possiblePhonesBR } = require('../../helpers/phoneHelper')
const { getEmpresaWhatsappConfig } = require('../whatsappConfigService')
const { fetchWithRetry } = require('../../helpers/retryWithBackoff')

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
// Delay entre envios: 0 = sem delay (envio imediato). Ex: ULTRAMSG_SEND_DELAY_MS=0 para desativar.
const MIN_DELAY_BETWEEN_SENDS_MS = Math.max(0, Number(process.env.ULTRAMSG_SEND_DELAY_MS) ?? 0)
const BODY_MAX_LEN = 4096
const CAPTION_MAX_LEN = 1024
const FILENAME_MAX_LEN = 255
const CHATS_MESSAGES_LIMIT_MAX = 1000
const ULTRAMSG_TIMEOUT_MS = Number(process.env.ULTRAMSG_TIMEOUT_MS) || 30_000
const lastSendPerCompany = new Map()
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

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
  
  // Log mais compacto para erros conhecidos em modo debug
  if (isKnownProfilePictureError && WHATSAPP_DEBUG) {
    console.log(`[ULTRAMSG] Profile picture not available: ${params?.chatId || 'unknown'}`)
  } else {
    console.log(JSON.stringify(logPayload, null, 2))
  }
}

async function awaitSendDelay(companyId) {
  if (MIN_DELAY_BETWEEN_SENDS_MS <= 0) return
  const key = companyId ?? 'default'
  const last = lastSendPerCompany.get(key) || 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_DELAY_BETWEEN_SENDS_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_BETWEEN_SENDS_MS - elapsed))
  }
  lastSendPerCompany.set(key, Date.now())
}

/**
 * Resolve config (basePath, token) para chamadas à UltraMsg.
 * @param {{ companyId?: number }} [opts]
 */
async function resolveConfig(opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (companyId == null || companyId === '') return null
  const { config, error } = await getEmpresaWhatsappConfig(Number(companyId))
  if (error || !config) {
    console.warn(`[ULTRAMSG] Empresa ${companyId} sem instância configurada (empresa_zapi).`, error || 'config vazio')
    return null
  }
  const instanceId = String(config.instance_id || '').trim()
  const token = String(config.instance_token || '').trim()
  if (!instanceId || !token) return null
  const segment = instanceId.toLowerCase().startsWith('instance') ? instanceId : `instance${instanceId}`
  const basePath = `${ULTRAMSG_BASE_URL}/${encodeURIComponent(segment)}`
  return { basePath, token }
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

async function post({ basePath, token, endpoint, body }) {
  const url = `${basePath}${endpoint}`
  const payload = appendToken(body || {}, token)
  const fetchOpts = createFetchOptions('POST', payload)
  const res = await fetchWithRetry(url, fetchOpts)
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  logUltramsgRequest({
    method: 'POST',
    url,
    headers: fetchOpts.headers || {},
    body: payload,
    responseStatus: res.status,
    responseData: data,
    responseText: text
  })
  return { ok: res.ok, status: res.status, data, text }
}

async function get({ basePath, token, endpoint, extraParams = {} }) {
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
async function postJson({ basePath, token, endpoint, body }) {
  return post({ basePath, token, endpoint, body })
}

async function getJson({ basePath, token, endpoint, extraParams = {} }) {
  return get({ basePath, token, endpoint, extraParams })
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

/**
 * Envia mensagem de texto.
 */
async function sendText(phone, message, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  await awaitSendDelay(companyId)
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

  const { ok, status, data, text } = await postJson({ ...cfg, endpoint: '/messages/chat', body })
  // UltraMsg retorna HTTP 200 mesmo em caso de erro (ex.: token inválido) — checar body também
  const bodyError = data?.error || (!data?.id && !data?.sent && !data?.messageId && data?.message)
  if (!ok || bodyError) {
    const err = data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`
    console.warn('❌ UltraMsg sendText falhou:', nums[0]?.slice(-12), status, String(err).slice(0, 150), '| token:', maskToken(cfg.token))
    return { ok: false, messageId: null, error: String(err) }
  }
  const msgId = data?.id ?? data?.messageId ?? null
  const numLog = nums[0] ? (String(nums[0]).replace(/\D/g, '').length >= 13 ? String(nums[0]).slice(-13) : String(nums[0]).slice(-12)) : ''
  console.log('✅ UltraMsg mensagem enviada:', numLog || nums[0], msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return { ok: true, messageId: msgId ? String(msgId) : null }
}

/**
 * Envia link enriquecido (fallback: sendText com URL para preview automático).
 */
async function sendLink(phone, payload, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
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
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) return false
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = { to: nums[0], image: String(url).trim(), caption: captionTrim }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/image', body })
  if (!ok) {
    console.warn('❌ UltraMsg sendImage falhou:', nums[0]?.slice(-12), String(text || data?.error || '').slice(0, 150), '| token:', maskToken(cfg.token))
    return false
  }
  console.log('✅ UltraMsg imagem enviada:', nums[0]?.slice(-12))
  return true
}

/**
 * Envia áudio por URL.
 */
async function sendAudio(phone, audioUrl, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return false
  const body = { to: nums[0], audio: String(audioUrl).trim() }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/audio', body })
  if (!ok) return false
  console.log('✅ UltraMsg áudio enviado:', nums[0]?.slice(-12))
  return true
}

/**
 * Envia documento por URL.
 */
async function sendFile(phone, url, fileName = '', opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) return false
  const ext = fileName ? String(fileName).split('.').pop() : 'pdf'
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'pdf'
  const filenameRaw = fileName ? String(fileName).trim() : `file.${safeExt}`
  const filename = filenameRaw.slice(0, FILENAME_MAX_LEN)
  const body = { to: nums[0], document: String(url).trim(), filename, caption: '' }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/document', body })
  if (!ok) return false
  console.log('✅ UltraMsg arquivo enviado:', nums[0]?.slice(-12))
  return true
}

/**
 * Envia vídeo por URL.
 */
async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !videoUrl) return false
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = { to: nums[0], video: String(videoUrl).trim(), caption: captionTrim }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/video', body })
  if (!ok) return false
  console.log('✅ UltraMsg vídeo enviado:', nums[0]?.slice(-12))
  return true
}

/**
 * Envia figurinha (sticker) por URL.
 */
async function sendSticker(phone, sticker, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !sticker) return false
  const body = { to: nums[0], sticker: String(sticker).trim() }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/sticker', body })
  if (!ok) return false
  console.log('✅ UltraMsg sticker enviado:', nums[0]?.slice(-12))
  return true
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
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/reaction', body })
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
 */
async function sendVoice(phone, audioUrl, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !audioUrl) return false
  const body = { to: nums[0], audio: String(audioUrl).trim() }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/voice', body })
  if (!ok) return false
  console.log('✅ UltraMsg voice enviado:', nums[0]?.slice(-12))
  return true
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
  const { ok, data } = await postJson({ ...cfg, endpoint: '/messages/location', body })
  if (!ok) return { ok: false, messageId: null }
  const msgId = data?.id ?? data?.messageId ?? null
  console.log('✅ UltraMsg localização enviada:', nums[0]?.slice(-12))
  return { ok: true, messageId: msgId ? String(msgId) : null }
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
  const { ok, data } = await postJson({ ...cfg, endpoint: '/messages/vcard', body })
  if (!ok) return { ok: false, messageId: null }
  const msgId = data?.id ?? data?.messageId ?? null
  console.log('✅ UltraMsg contato enviado:', nums[0]?.slice(-12))
  return { ok: true, messageId: msgId ? String(msgId) : null }
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
 * Lista contatos salvos na agenda. UltraMsg: GET /{instance_id}/contacts
 * Doc oficial: apenas token obrigatório; limit/offset podem não existir.
 * Retorna apenas contatos com `name` definido (salvos na agenda do celular).
 * Exclui grupos (@g.us), broadcasts e contatos sem número BR válido.
 */
async function getContacts(page = 1, pageSize = 100, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  const limit = Math.min(100, Math.max(1, Number(pageSize) || 100))
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
    let raw = await tryFetch({ limit: String(limit), offset: String(offset) })
    if (raw.length === 0 && page === 1) {
      raw = await tryFetch({})
      if (WHATSAPP_DEBUG && raw.length > 0) {
        console.log('[ULTRAMSG] getContacts: sem limit/offset retornou', raw.length, 'contatos')
      }
    }
    if (WHATSAPP_DEBUG && page === 1) {
      console.log('[ULTRAMSG] getContacts:', { page, limit, offset, total: raw.length })
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
    return contacts
  } catch (e) {
    if (WHATSAPP_DEBUG) console.warn('[ULTRAMSG] getContacts erro:', e?.message)
    return []
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
 * Lista chats. UltraMsg: GET /{instance_id}/chats
 */
async function getChats(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/chats' })
    if (!ok || !Array.isArray(data)) return []
    return data
  } catch {
    return []
  }
}

/**
 * Lista grupos. UltraMsg: GET /{instance_id}/groups
 */
async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/groups' })
    if (!ok || !Array.isArray(data)) return []
    return data
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
setInterval(() => {
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

  // Verificar cache de contatos sem foto
  const cacheKey = `${cfg.instanceId}:${chatId}`
  const cachedNoPhoto = noProfilePictureCache.get(cacheKey)
  if (cachedNoPhoto && cachedNoPhoto.expiry > Date.now()) {
    // Contato já conhecido por não ter foto, retorna null silenciosamente
    return null
  }

  // Rate limiting por instância para evitar spam de requisições
  const rateLimitKey = `rate_limit:${cfg.instanceId}`
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
  if (!cfg) return []
  const nums = phoneCandidatesForLookup(phone)
  if (!nums.length) return []
  const raw = String(nums[0] || '').trim()
  const chatId = raw.endsWith('@g.us') ? raw : phoneToChatId(raw) || toUltramsgPhone(raw)
  if (!chatId) return []
  try {
    const limit = Math.min(CHATS_MESSAGES_LIMIT_MAX, Math.max(1, Number(amount) || 10))
    const { ok, data } = await getJson({
      ...cfg,
      endpoint: '/chats/messages',
      extraParams: { chatId, limit: String(limit) }
    })
    if (!ok) return []
    return Array.isArray(data) ? data : []
  } catch {
    return []
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
    form.append('file', fs.createReadStream(filePath), { filename: safeFilename.slice(0, FILENAME_MAX_LEN) })
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
    })
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    logUltramsgRequest({
      method: 'POST',
      url: uploadUrl,
      headers: { ...uploadHeaders, token: maskToken(cfg.token) },
      body: { file: safeFilename, token: maskToken(cfg.token) },
      responseStatus: res.status,
      responseData: data,
      responseText: text
    })
    if (!res.ok) {
      const err = data?.error || data?.message || `HTTP ${res.status}`
      console.warn('❌ UltraMsg uploadMedia falhou:', safeFilename?.slice(-20), err, '| token:', maskToken(cfg.token))
      return { ok: false, url: null, error: err }
    }
    const url = data?.url || data?.link || data?.file || null
    return { ok: !!url, url }
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
  const webhookToken = String(process.env.WHATSAPP_WEBHOOK_TOKEN || process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix = webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''
  const webhookUrl = `${base}/webhooks/ultramsg${tokenSuffix}`

  const sendDelay = Math.max(1, Math.min(60, Number(process.env.ULTRAMSG_SEND_DELAY) || 1))
  const sendDelayMax = Math.max(1, Math.min(120, Math.max(sendDelay, Number(process.env.ULTRAMSG_SEND_DELAY_MAX) || 15)))
  const webhookDownloadMedia = process.env.ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA === 'true'
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
