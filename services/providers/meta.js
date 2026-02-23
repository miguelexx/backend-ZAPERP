/**
 * Provider Meta (WhatsApp Cloud API).
 * Usa a função existente do webhookController para não alterar a lógica do CRM.
 */

const { enviarMensagemWhatsApp } = require('../../controllers/webhookController')

function getMetaConfig(opts = {}) {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN
  const defaultPhoneId = process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID
  const phoneId = opts?.phoneId || defaultPhoneId
  if (!token || !phoneId) return null
  return { token: String(token).trim(), phoneId: String(phoneId).trim() }
}

async function postMessage(body, { token, phoneId }) {
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  const messageId = json?.messages?.[0]?.id ? String(json.messages[0].id).trim() : null
  // Meta pode retornar 200 com error no body em casos específicos
  const ok = !!res.ok && !json?.error
  return { ok, messageId }
}

/**
 * Envia mensagem de texto via Meta Cloud API.
 * @param {string} phone - Telefone (apenas dígitos)
 * @param {string} message - Texto
 * @param {{ phoneId?: string, replyMessageId?: string }} [opts] - phoneId multi-tenant + reply (context)
 * @returns {Promise<{ ok: boolean, messageId: string|null }>}
 */
async function sendText(phone, message, opts = {}) {
  const phoneId = opts?.phoneId || undefined
  const replyMessageId = opts?.replyMessageId || null
  return enviarMensagemWhatsApp(phone, message, phoneId, replyMessageId)
}

/**
 * Meta Cloud API: envio de imagem por LINK público (HTTPS).
 * Observação: para links, o servidor que hospeda o arquivo deve permitir download pelo WhatsApp.
 * @returns {Promise<boolean>}
 */
async function sendImage(phone, url, caption = '', opts = {}) {
  const cfg = getMetaConfig(opts)
  if (!cfg) return false
  const num = String(phone || '').replace(/\D/g, '')
  const link = String(url || '').trim()
  if (!num || !link) return false
  const body = {
    messaging_product: 'whatsapp',
    to: num,
    type: 'image',
    image: { link, ...(caption ? { caption: String(caption).trim() } : {}) },
  }
  const { ok } = await postMessage(body, cfg).catch(() => ({ ok: false }))
  return !!ok
}

/**
 * Meta Cloud API: envio de documento por LINK público (HTTPS).
 * @returns {Promise<boolean>}
 */
async function sendFile(phone, url, fileName = '', opts = {}) {
  const cfg = getMetaConfig(opts)
  if (!cfg) return false
  const num = String(phone || '').replace(/\D/g, '')
  const link = String(url || '').trim()
  if (!num || !link) return false
  const body = {
    messaging_product: 'whatsapp',
    to: num,
    type: 'document',
    document: { link, ...(fileName ? { filename: String(fileName).trim() } : {}) },
  }
  const { ok } = await postMessage(body, cfg).catch(() => ({ ok: false }))
  return !!ok
}

/**
 * Meta Cloud API: envio de áudio por LINK público (HTTPS).
 * @returns {Promise<boolean>}
 */
async function sendAudio(phone, audioUrl, opts = {}) {
  const cfg = getMetaConfig(opts)
  if (!cfg) return false
  const num = String(phone || '').replace(/\D/g, '')
  const link = String(audioUrl || '').trim()
  if (!num || !link) return false
  const body = {
    messaging_product: 'whatsapp',
    to: num,
    type: 'audio',
    audio: { link },
  }
  const { ok } = await postMessage(body, cfg).catch(() => ({ ok: false }))
  return !!ok
}

/**
 * Meta Cloud API: envio de vídeo por LINK público (HTTPS).
 * @returns {Promise<boolean>}
 */
async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const cfg = getMetaConfig(opts)
  if (!cfg) return false
  const num = String(phone || '').replace(/\D/g, '')
  const link = String(videoUrl || '').trim()
  if (!num || !link) return false
  const body = {
    messaging_product: 'whatsapp',
    to: num,
    type: 'video',
    video: { link, ...(caption ? { caption: String(caption).trim() } : {}) },
  }
  const { ok } = await postMessage(body, cfg).catch(() => ({ ok: false }))
  return !!ok
}

async function sendSticker(phone, stickerUrl, opts = {}) {
  const cfg = getMetaConfig(opts)
  if (!cfg) return false
  const num = String(phone || '').replace(/\D/g, '')
  const link = String(stickerUrl || '').trim()
  if (!num || !link) return false
  const body = {
    messaging_product: 'whatsapp',
    to: num,
    type: 'sticker',
    sticker: { link },
  }
  const { ok } = await postMessage(body, cfg).catch(() => ({ ok: false }))
  return !!ok
}

module.exports = {
  sendText,
  sendImage,
  sendFile,
  sendAudio,
  sendVideo,
  sendSticker
}
