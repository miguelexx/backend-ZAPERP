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
const { permitirEnvio } = require('../protecao/protecaoOrchestrator')

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
// Delay entre envios: 0 = sem delay (envio imediato). Ex: ULTRAMSG_SEND_DELAY_MS=0 para desativar.
const MIN_DELAY_BETWEEN_SENDS_MS = Math.max(0, Number(process.env.ULTRAMSG_SEND_DELAY_MS) ?? 0)
const BODY_MAX_LEN = 4096
const CAPTION_MAX_LEN = 1024
const FILENAME_MAX_LEN = 255
const CHATS_MESSAGES_LIMIT_MAX = 1000
const ULTRAMSG_TIMEOUT_MS = Number(process.env.ULTRAMSG_TIMEOUT_MS) || 30_000
const lastSendPerCompany = new Map()

// ========== Camada centralizada UltraMsg (contrato oficial) ==========

/** Constrói base URL: https://api.ultramsg.com/{instance_id} */
function buildBaseUrl(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') return ''
  return `${ULTRAMSG_BASE_URL}/${encodeURIComponent(String(instanceId).trim())}`
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
  const basePath = `${ULTRAMSG_BASE_URL}/${encodeURIComponent(instanceId)}`
  return { basePath, token }
}

/** Converte número para formato UltraMsg: +5534999999999 ou 120...@g.us */
function toUltramsgPhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us') || s.includes('-group')) return s.includes('@') ? s : `${s.replace(/-group$/, '')}@g.us`
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  const fmt = toZapiSendFormat(digits) || (digits.startsWith('55') ? digits : '55' + digits)
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
    opts.headers = { ...opts.headers, 'Content-Type': 'application/json' }
    opts.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return opts
}

async function post({ basePath, token, endpoint, body }) {
  const url = `${basePath}${endpoint}`
  const payload = appendToken(body || {}, token)
  const res = await fetchWithRetry(url, createFetchOptions('POST', payload))
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data, text }
}

async function get({ basePath, token, endpoint, extraParams = {} }) {
  const sep = String(endpoint || '').includes('?') ? '&' : '?'
  const params = new URLSearchParams(appendToken(extraParams, token))
  const url = `${basePath}${endpoint}${sep}${params.toString()}`
  const res = await fetchWithRetry(url, createFetchOptions('GET'))
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
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
  const protecao = await permitirEnvio({
    company_id: companyId,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
    cliente_id: opts?.clienteId ?? opts?.cliente_id,
    requireOptIn: opts?.requireOptIn || false
  })
  if (!protecao.allow) {
    console.warn('[ULTRAMSG] sendText bloqueado por proteção:', protecao.reason || 'proteção')
    return { ok: false, messageId: null, blockedBy: protecao.reason }
  }
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
  if (!ok) {
    const err = data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`
    console.warn('❌ UltraMsg sendText falhou:', nums[0]?.slice(-12), status, String(err).slice(0, 150), '| token:', maskToken(cfg.token))
    return { ok: false, messageId: null, error: err }
  }
  const msgId = data?.id ?? data?.messageId ?? null
  console.log('✅ UltraMsg mensagem enviada:', nums[0]?.slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return { ok: true, messageId: msgId ? String(msgId) : null }
}

/**
 * Envia link enriquecido (fallback: sendText com URL para preview automático).
 */
async function sendLink(phone, payload, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return { ok: false, messageId: null }
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return false
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return { ok: false, messageId: null }
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
 * Compartilha contato via vCard.
 */
async function sendContact(phone, contactName, contactPhone, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id
  })
  if (!protecao.allow) return { ok: false, messageId: null }
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
 * Lista contatos. UltraMsg: GET /{instance_id}/contacts
 * Doc oficial: apenas token obrigatório; limit/offset podem não existir.
 */
async function getContacts(page = 1, pageSize = 100, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const limit = Math.min(100, Math.max(1, Number(pageSize) || 100))
    const offset = (Math.max(1, Number(page)) - 1) * limit
    const { ok, data } = await getJson({
      ...cfg,
      endpoint: '/contacts',
      extraParams: { limit: String(limit), offset: String(offset) }
    })
    if (!ok) return []
    const raw = parseContactsResponse(data)
    return raw.map((c) => ({
      phone: c.id || c.phone || c.wa_id || '',
      name: c.name || null,
      short: c.short || null,
      notify: c.notify || null,
      vname: c.vname || null,
      imgUrl: c.imgUrl || c.photo || null
    }))
  } catch {
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
 * Converte phone para chatId no formato WhatsApp (55xxx@c.us ou 120xxx@g.us).
 */
function phoneToChatId(phone) {
  const s = String(phone || '').trim()
  if (!s) return null
  if (s.endsWith('@g.us')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  const fmt = digits.startsWith('55') ? digits : '55' + digits
  return `${fmt}@c.us`
}

/**
 * Busca URL da foto de perfil.
 * Doc oficial: GET /{instance_id}/contacts/image?token={TOKEN}&chatId={chatId}
 * Parâmetros obrigatórios: token, chatId (ex.: 5511999999999@c.us)
 * Aceita phone (será convertido) ou opts.chatId quando disponível (ex.: data.from do webhook).
 * Nunca expor token em logs.
 */
async function getProfilePicture(phoneOrChatId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const chatId = opts.chatId && String(opts.chatId).trim().endsWith('@c.us')
    ? String(opts.chatId).trim()
    : phoneToChatId(phoneOrChatId)
  if (!chatId || chatId.endsWith('@g.us')) return null
  try {
    const { ok, data, text } = await get({
      ...cfg,
      endpoint: '/contacts/image',
      extraParams: { chatId }
    })
    if (!ok) return null
    // Resposta pode ser objeto JSON ou string (URL direta). Múltiplos campos possíveis.
    let url = null
    if (data && typeof data === 'object') {
      url = data.url ?? data.image ?? data.img ?? data.profilePicture ?? data.profilePic ?? data.link ?? null
    }
    if (!url && typeof text === 'string' && text.trim().startsWith('http')) url = text.trim()
    return url && typeof url === 'string' ? url.trim() : null
  } catch {
    return null
  }
}

/**
 * Metadados do contato. UltraMsg: GET /contacts/contact?chatId=... ou busca em GET /contacts.
 * Retorna: { name, short, notify, vname, imgUrl } para ultramsgSyncContact.
 */
async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const chatId = phoneToChatId(phone)
  if (!chatId) return null
  try {
    const { ok, data } = await getJson({
      ...cfg,
      endpoint: '/contacts/contact',
      extraParams: { chatId }
    })
    if (ok && data && typeof data === 'object') {
      return {
        name: data.name ?? data.formattedName ?? null,
        short: data.short ?? null,
        notify: data.notify ?? data.pushName ?? null,
        vname: data.vname ?? null,
        imgUrl: data.imgUrl ?? data.photo ?? data.profilePicture ?? null
      }
    }
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
        return {
          name: found.name ?? null,
          short: found.short ?? null,
          notify: found.notify ?? null,
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
    const res = await fetchWithRetry(`${cfg.basePath}/media/upload`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      ...(signal && { signal })
    })
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
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
  const sendDelayMax = Math.max(1, Math.min(120, Number(process.env.ULTRAMSG_SEND_DELAY_MAX) || 15))
  const webhookDownloadMedia = process.env.ULTRAMSG_WEBHOOK_DOWNLOAD_MEDIA === 'true'
  const body = {
    token: cfg.token,
    webhook_url: webhookUrl,
    webhook_message_received: true,
    webhook_message_create: true,
    webhook_message_ack: true,
    webhook_message_download_media: webhookDownloadMedia,
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
  archiveChat,
  unarchiveChat,
  readChat,
  clearChatMessages,
  deleteChat,
  getContacts,
  getChats,
  getGroups,
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
