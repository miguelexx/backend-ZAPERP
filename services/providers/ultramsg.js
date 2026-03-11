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
const { getEmpresaZapiConfig } = require('../zapiIntegrationService')
const { fetchWithRetry } = require('../../helpers/retryWithBackoff')
const { permitirEnvio } = require('../protecao/protecaoOrchestrator')

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
const MIN_DELAY_BETWEEN_SENDS_MS = Math.min(500, Math.max(150, Number(process.env.ULTRAMSG_SEND_DELAY_MS) || 280))
const lastSendPerCompany = new Map()

async function awaitSendDelay(companyId) {
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
  const { config, error } = await getEmpresaZapiConfig(Number(companyId))
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

async function postJson({ basePath, token, endpoint, body }) {
  const url = `${basePath}${endpoint}`
  const payload = { ...body, token }
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data, text }
}

async function getJson({ basePath, token, endpoint }) {
  const url = `${basePath}${endpoint}?token=${encodeURIComponent(token)}`
  const res = await fetchWithRetry(url, { method: 'GET', headers: { accept: 'application/json' } })
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data, text }
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
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  const body = { to: nums[0], body: String(message).trim() }
  if (replyMessageId) body.msgId = replyMessageId

  const { ok, status, data, text } = await postJson({ ...cfg, endpoint: '/messages/chat', body })
  if (!ok) {
    const err = data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`
    console.warn('❌ UltraMsg sendText falhou:', nums[0]?.slice(-12), status, String(err).slice(0, 150))
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
  const body = { to: nums[0], image: String(url).trim(), caption: String(caption || '').trim() }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/image', body })
  if (!ok) {
    console.warn('❌ UltraMsg sendImage falhou:', nums[0]?.slice(-12), String(text || data?.error || '').slice(0, 150))
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
  const filename = fileName ? String(fileName).trim() : `file.${safeExt}`
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
  const body = { to: nums[0], video: String(videoUrl).trim(), caption: String(caption || '').trim() }
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
 * Lista contatos. UltraMsg não expõe endpoint GET /contacts — retorna [].
 */
async function getContacts(page = 1, pageSize = 100, opts = {}) {
  return []
}

/**
 * Busca URL da foto de perfil. UltraMsg pode não ter endpoint — retorna null.
 */
async function getProfilePicture(phone, opts = {}) {
  return null
}

/**
 * Metadados do contato. UltraMsg pode não ter — retorna null.
 */
async function getContactMetadata(phone, opts = {}) {
  return null
}

/**
 * Mensagens do chat. UltraMsg: GET /chats/messages.
 */
async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  const nums = phoneCandidatesForLookup(phone)
  if (!nums.length) return []
  const to = toUltramsgPhone(nums[0])
  if (!to) return []
  try {
    const url = `${cfg.basePath}/chats/messages?token=${encodeURIComponent(cfg.token)}&chatId=${encodeURIComponent(to)}`
    const res = await fetchWithRetry(url, { method: 'GET' })
    if (!res.ok) return []
    const data = await res.json().catch(() => null)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * Configura webhooks na instância UltraMsg.
 */
async function configureWebhooks(appUrl, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !appUrl) return []
  const base = String(appUrl).replace(/\/$/, '')
  const webhookToken = String(process.env.ULTRAMSG_WEBHOOK_TOKEN || process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix = webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''
  const webhookUrl = `${base}/webhooks/ultramsg${tokenSuffix}`

  const body = {
    token: cfg.token,
    webhook_url: webhookUrl,
    webhook_message_received: true,
    webhook_message_create: true,
    webhook_message_ack: true,
    webhook_message_download_media: false,
    sendDelay: 1,
    sendDelayMax: 15
  }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/instance/settings', body })
  if (ok) {
    console.log('✅ UltraMsg webhooks configurados:', webhookUrl)
    return [{ label: 'webhook', ok: true }]
  }
  console.warn('⚠️ UltraMsg configureWebhooks falhou:', String(text || data?.error || '').slice(0, 200))
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
    const connected = status === 'authenticated' || status === 'connected' || data?.connected === true
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
  sendVideo,
  sendReaction,
  removeReaction,
  sendContact,
  sendCall,
  sendSticker,
  getContacts,
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
  isConfigured: true
}
