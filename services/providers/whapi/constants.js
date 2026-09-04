/**
 * Limites e env do adapter Whapi Cloud (2º provider WhatsApp, opcional por instância).
 * Credenciais NÃO vêm daqui — só de resolveConfig / whatsapp_instances (provider='whapi').
 * Base: https://gate.whapi.cloud · Bearer token · JSON (não form-urlencoded).
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const WHAPI_BASE_URL = (process.env.WHAPI_BASE_URL || 'https://gate.whapi.cloud').replace(/\/$/, '')
const WHAPI_TIMEOUT_MS = Number(process.env.WHAPI_TIMEOUT_MS) || 30_000
const BODY_MAX_LEN = 4096
const CAPTION_MAX_LEN = 1024
const FILENAME_MAX_LEN = 255
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

module.exports = {
  WHAPI_BASE_URL,
  WHAPI_TIMEOUT_MS,
  BODY_MAX_LEN,
  CAPTION_MAX_LEN,
  FILENAME_MAX_LEN,
  WHATSAPP_DEBUG,
}
