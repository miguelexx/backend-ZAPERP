/**
 * Provider Meta (WhatsApp Cloud API).
 * Usa a função existente do webhookController para não alterar a lógica do CRM.
 */

const { enviarMensagemWhatsApp } = require('../../controllers/webhookController')

/**
 * Envia mensagem de texto via Meta Cloud API.
 * @param {string} phone - Telefone (apenas dígitos)
 * @param {string} message - Texto
 * @param {{ phoneId?: string }} [opts] - phoneId para multi-tenant (empresas_whatsapp)
 * @returns {Promise<boolean>}
 */
async function sendText(phone, message, opts = {}) {
  const phoneId = opts?.phoneId || undefined
  return enviarMensagemWhatsApp(phone, message, phoneId)
}

/**
 * Meta Cloud API: envio de imagem por URL exige upload de mídia antes.
 * Não implementado neste adapter; manter interface para troca de provider.
 * @returns {Promise<boolean>} false
 */
async function sendImage() {
  return false
}

/**
 * Meta Cloud API: envio de arquivo por URL exige upload de mídia antes.
 * Não implementado neste adapter.
 * @returns {Promise<boolean>} false
 */
async function sendFile() {
  return false
}

/**
 * Meta Cloud API: envio de áudio por URL exige upload de mídia antes.
 * Não implementado neste adapter.
 * @returns {Promise<boolean>} false
 */
async function sendAudio() {
  return false
}

/**
 * Meta Cloud API: envio de vídeo por URL exige upload de mídia antes.
 * Não implementado neste adapter.
 * @returns {Promise<boolean>} false
 */
async function sendVideo() {
  return false
}

async function sendSticker() {
  return false
}

module.exports = {
  sendText,
  sendImage,
  sendFile,
  sendAudio,
  sendVideo,
  sendSticker
}
