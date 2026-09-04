/**
 * Envio Whapi. Fase B: texto + mídia + reação + contato + localização.
 * Whapi: JSON + Bearer. Mídia: campo `media` (URL HTTP(S), media id ou data URI).
 * Resposta síncrona CONFIRMADA: { sent: true, message?: { id } }.
 * sendCall e deleteMessage continuam stub 501 (não fingem sucesso).
 */

const { buildSendMeta } = require('../../whatsappSendGuardService')
const { BODY_MAX_LEN, CAPTION_MAX_LEN, FILENAME_MAX_LEN } = require('./constants')
const { normalizeWhapiSendResult } = require('./result')
const { toWhapiRecipient } = require('./phones')
const { resolveConfig } = require('./config')
const { post, put, maskToken } = require('./http')

function notImplemented(method) {
  return { ok: false, messageId: null, notImplemented: true, httpStatus: 501, error: `whapi.${method} não implementado` }
}

function applyQuoted(body, opts) {
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  if (replyMessageId) body.quoted = replyMessageId
  return body
}

function asMediaResult(normalized, returnDetails) {
  if (!normalized.ok) return returnDetails ? normalized : false
  return returnDetails ? normalized : true
}

async function postMessage({ cfg, endpoint, body, to, kind, opts, extraMeta }) {
  const { ok, status, data, text } = await post({
    token: cfg.token,
    endpoint,
    body,
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    meta: buildSendMeta(kind, to, opts, extraMeta),
  })
  return normalizeWhapiSendResult({ httpOk: ok, status, data, text, fallbackError: data?.message })
}

/**
 * Envia mensagem de texto via Whapi.
 * Retorna { ok, messageId, error, ... } — objeto, como o UltraMSG (nunca boolean).
 */
async function sendText(phone, message, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  }
  const to = toWhapiRecipient(phone)
  if (!to || !message) {
    return { ok: false, messageId: null, error: 'Número inválido ou mensagem vazia.' }
  }
  const msg = String(message).trim()
  if (msg.length > BODY_MAX_LEN) {
    return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }
  }
  const body = applyQuoted({ to, body: msg }, opts)

  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint: '/messages/text', body, to, kind: 'text', opts, extraMeta: { textLength: msg.length },
    })
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }

  if (!normalized.ok) {
    console.warn('❌ Whapi sendText falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
    return normalized
  }
  console.log('✅ Whapi mensagem enviada:', String(to).slice(-13), normalized.messageId ? `id=${String(normalized.messageId).slice(0, 16)}...` : '')
  return normalized
}

async function sendLink(phone, payload, opts = {}) {
  const linkUrl = String(payload?.linkUrl || '').trim()
  const title = String(payload?.title || '').trim()
  const desc = String(payload?.linkDescription || '').trim()
  const msg = String(payload?.message || '').trim() || [title, desc, linkUrl].filter(Boolean).join('\n')
  return sendText(phone, msg, opts)
}

async function sendMediaByEndpoint(endpoint, kind, phone, media, extra = {}, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Instância Whapi não configurada' } : false
  const to = toWhapiRecipient(phone)
  const mediaStr = media == null ? '' : String(media).trim()
  if (!to || !mediaStr) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou mídia inválido' } : false
  }
  const body = applyQuoted({ to, media: mediaStr, ...extra }, opts)
  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint, body, to, kind, opts, extraMeta: { textLength: String(extra?.caption || '').length },
    })
  } catch (e) {
    return returnDetails ? { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` } : false
  }
  if (!normalized.ok) {
    console.warn(`❌ Whapi ${kind} falhou:`, String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
  } else {
    console.log(`✅ Whapi ${kind} enviado:`, String(to).slice(-13), normalized.messageId ? `id=${String(normalized.messageId).slice(0, 16)}...` : '')
  }
  return asMediaResult(normalized, returnDetails)
}

async function sendImage(phone, url, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/image', 'image', phone, url, extra, opts)
}

async function sendFile(phone, url, fileName = '', opts = {}) {
  const extra = {}
  const filenameRaw = fileName ? String(fileName).trim() : ''
  if (filenameRaw) extra.filename = filenameRaw.slice(0, FILENAME_MAX_LEN)
  const captionTrim = String(opts?.caption || '').trim().slice(0, CAPTION_MAX_LEN)
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/document', 'file', phone, url, extra, opts)
}

async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/video', 'video', phone, videoUrl, extra, opts)
}

async function sendSticker(phone, sticker, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/sticker', 'sticker', phone, sticker, extra, opts)
}

async function sendAudio(phone, audioUrl, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/audio', 'audio', phone, audioUrl, extra, opts)
}

async function sendVoice(phone, audioUrl, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/voice', 'voice', phone, audioUrl, extra, opts)
}

/**
 * Reação: PUT /messages/{MessageID}/reaction { emoji }.
 * Contrato do chat UltraMSG: retorno boolean (objeto truthy quebraria `if (!ok)`).
 */
async function sendReaction(phone, messageId, reaction, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  const emoji = String(reaction || '').trim()
  if (!mid || !emoji) return false
  const to = toWhapiRecipient(phone)
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/reaction`,
      body: { emoji },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('reaction', to || phone, opts),
    })
    return !!ok
  } catch (e) {
    console.warn('❌ Whapi sendReaction falhou:', e?.message || e)
    return false
  }
}

/** Whapi: emoji em branco remove a reação. */
async function removeReaction(phone, messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  if (!mid) return false
  const to = toWhapiRecipient(phone)
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/reaction`,
      body: { emoji: '' },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('reaction', to || phone, opts),
    })
    return !!ok
  } catch (e) {
    console.warn('❌ Whapi removeReaction falhou:', e?.message || e)
    return false
  }
}

async function sendLocation(phone, loc = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const to = toWhapiRecipient(phone)
  const latitude = Number(loc.latitude ?? loc.lat)
  const longitude = Number(loc.longitude ?? loc.lng)
  if (!to || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, messageId: null, error: 'Destino ou coordenadas inválidos' }
  }
  const body = applyQuoted({
    to,
    latitude,
    longitude,
    ...(loc.address || loc.name ? {
      address: String(loc.address || '').slice(0, 300),
      name: String(loc.name || '').slice(0, 120),
    } : {}),
  }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/location', body, to, kind: 'location', opts,
    })
    if (!normalized.ok) return { ...normalized, ok: false }
    console.log('✅ Whapi localização enviada:', String(to).slice(-13))
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }
}

async function sendContact(phone, contactName, contactPhone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const to = toWhapiRecipient(phone)
  const name = String(contactName || '').trim()
  const contact = String(contactPhone || '').replace(/\D/g, '')
  if (!to || !name || !contact) return { ok: false, messageId: null, error: 'Destino ou contato inválido' }
  const tel = contact.startsWith('55') ? contact : `55${contact}`
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${name};;;\nFN:${name}\nTEL;TYPE=CELL;waid=${tel}:+${tel}\nEND:VCARD`
  const body = applyQuoted({ to, name, vcard }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/contact', body, to, kind: 'contact', opts,
    })
    if (!normalized.ok) return { ...normalized, ok: false }
    console.log('✅ Whapi contato enviado:', String(to).slice(-13))
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }
}

async function sendCall() {
  return notImplemented('sendCall')
}

async function deleteMessage() {
  return notImplemented('deleteMessage')
}

module.exports = {
  sendText,
  sendLink,
  sendImage,
  sendFile,
  sendVideo,
  sendSticker,
  sendAudio,
  sendVoice,
  sendContact,
  sendLocation,
  sendReaction,
  removeReaction,
  sendCall,
  deleteMessage,
  notImplemented,
}
