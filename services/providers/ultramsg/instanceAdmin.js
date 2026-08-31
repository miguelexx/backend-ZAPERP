const { interpretUltramsgInstanceStatus } = require('../../../helpers/ultramsgStatusHelper')
const { resolveConfig } = require('./config')
const { postJson, getJson, maskToken } = require('./http')

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
  if (!cfg) return { connected: false, configured: false, conclusive: false }
  try {
    const { ok, data, text } = await getJson({ ...cfg, endpoint: '/instance/status' })
    if (!ok) return { connected: false, configured: true, conclusive: false }
    const interpreted = interpretUltramsgInstanceStatus(data, text)
    const phone = data?.phone ?? data?.wid ?? data?.status?.phone ?? null
    return {
      connected: interpreted.connected,
      configured: true,
      conclusive: interpreted.conclusive,
      status: interpreted.status,
      phone,
      session: data?.session ?? null,
    }
  } catch (e) {
    console.warn('[ULTRAMSG] getConnectionStatus:', e?.message || e)
    return { connected: false, configured: true, conclusive: false }
  }
}

module.exports = {
  configureWebhooks,
  updateProfilePicture,
  updateProfileName,
  updateProfileDescription,
  getConnectionStatus,
}
