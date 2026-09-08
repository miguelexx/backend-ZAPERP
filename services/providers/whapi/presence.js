/**
 * Presença Whapi — indicador "digitando…/gravando…" no chat do cliente.
 * PUT /presences/{EntryID}  body { presence, delay? }   (typing | recording | paused)
 * PUT /presences/me         body { presence }            (online | offline)
 *
 * UX: dá sensação humana antes do envio. É um sinal leve — skipSendGuard (não consome
 * o orçamento de rate de envio). Falha aqui NUNCA pode bloquear a mensagem real.
 * Contrato confirmado via MCP (sendPresence: EntryID, presence, delay). Ver doc 25.
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId, isGroupJid } = require('./phones')
const { put } = require('./http')

const CHAT_PRESENCES = new Set(['typing', 'recording', 'paused'])
const ME_PRESENCES = new Set(['online', 'offline'])
const DELAY_MAX_S = 25

function clampDelay(delay) {
  const n = Number(delay)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(DELAY_MAX_S, Math.round(n))
}

/**
 * Mostra/limpa o indicador de digitação/gravação num chat.
 * @param {string} phone contato ou grupo
 * @param {string} presence typing | recording | paused (default typing)
 * @param {{companyId, whatsappInstanceId, delay?}} opts
 * @returns {Promise<boolean>} true se aceito pelo provedor
 */
async function sendPresence(phone, presence = 'typing', opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const entryId = toWhapiChatId(phone)
  if (!entryId) return false
  const pres = String(presence || 'typing').trim().toLowerCase()
  if (!CHAT_PRESENCES.has(pres)) return false
  const body = { presence: pres }
  const delay = clampDelay(opts?.delay)
  if (delay != null) body.delay = delay
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: `/presences/${encodeURIComponent(entryId)}`,
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return Boolean(ok)
  } catch {
    return false
  }
}

/**
 * Define a presença da própria conta conectada (online/offline).
 * @param {string} presence online | offline
 * @returns {Promise<boolean>}
 */
async function setMePresence(presence, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const pres = String(presence || '').trim().toLowerCase()
  if (!ME_PRESENCES.has(pres)) return false
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: '/presences/me',
      body: { presence: pres },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return Boolean(ok)
  } catch {
    return false
  }
}

module.exports = {
  sendPresence,
  setMePresence,
  CHAT_PRESENCES,
  ME_PRESENCES,
  isGroupJid,
}
