/**
 * Limites e env do adapter UltraMSG.
 * Credenciais NÃO vêm daqui — só de resolveConfig / whatsapp_instances.
 */

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
// Delay entre envios: 0 = sem delay (envio imediato). Ex: ULTRAMSG_SEND_DELAY_MS=0 para desativar.
const MIN_DELAY_BETWEEN_SENDS_MS = Math.max(0, Number(process.env.ULTRAMSG_SEND_DELAY_MS) ?? 0)
const BODY_MAX_LEN = 4096
const CAPTION_MAX_LEN = 1024
const FILENAME_MAX_LEN = 255
const CHATS_MESSAGES_LIMIT_MAX = 1000
const OLD_MESSAGES_SYNC_MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.OLD_MESSAGES_SYNC_MAX_PAGES) || 10))
const ULTRAMSG_TIMEOUT_MS = Number(process.env.ULTRAMSG_TIMEOUT_MS) || 30_000
const LAST_SEND_MAP_MAX = 500
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'
const CONTACTS_API_CHUNK_MAX = 10000

module.exports = {
  ULTRAMSG_BASE_URL,
  MIN_DELAY_BETWEEN_SENDS_MS,
  BODY_MAX_LEN,
  CAPTION_MAX_LEN,
  FILENAME_MAX_LEN,
  CHATS_MESSAGES_LIMIT_MAX,
  OLD_MESSAGES_SYNC_MAX_PAGES,
  ULTRAMSG_TIMEOUT_MS,
  LAST_SEND_MAP_MAX,
  WHATSAPP_DEBUG,
  CONTACTS_API_CHUNK_MAX,
}
