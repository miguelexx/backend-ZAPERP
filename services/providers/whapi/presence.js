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
const { put, get, post } = require('./http')

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

/**
 * Assina as atualizações de presença de um contato/grupo — precondição para getPresence
 * retornar algo. POST /presences/{EntryID}. Retorna { ok, error? }.
 * O canal só passa a emitir eventos `presences` (webhook) após assinar (e assinar o evento).
 */
async function subscribePresence(entry, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const entryId = toWhapiChatId(entry)
  if (!entryId) return { ok: false, error: 'Contato/grupo inválido.' }
  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: `/presences/${encodeURIComponent(entryId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao assinar presença (Whapi): ${e?.message || e}` }
  }
}

/**
 * Última presença conhecida de um contato/grupo (online/offline + visto por último).
 * GET /presences/{EntryID}. Só retorna dado real APÓS subscribePresence.
 * Retorna { ok, status: 'online'|'offline'|'typing'|'recording'|'pending', lastSeen, data }.
 */
async function getPresence(entry, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const entryId = toWhapiChatId(entry)
  if (!entryId) return { ok: false, error: 'Contato/grupo inválido.' }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: `/presences/${encodeURIComponent(entryId)}` })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    const lastSeenRaw = data?.last_seen ?? data?.lastSeen
    const lastSeen = Number.isFinite(Number(lastSeenRaw)) ? Number(lastSeenRaw) : null
    return {
      ok: true,
      entryId,
      status: data?.status || data?.presence || null,
      lastSeen,
      data,
      httpStatus: status,
    }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler presença (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  sendPresence,
  setMePresence,
  subscribePresence,
  getPresence,
  CHAT_PRESENCES,
  ME_PRESENCES,
  isGroupJid,
}
