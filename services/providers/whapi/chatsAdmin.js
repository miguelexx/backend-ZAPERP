/**
 * Chat admin Whapi — arquivos próprios (não misturar com UltraMSG).
 * Archive: POST /chats/{ChatID} { archive }
 * Read:    PATCH /chats/{ChatID} { mark_unread: false }
 * Delete:  DELETE /chats/{ChatID}
 * List:    GET /chats · GET /groups · GET /groups/{GroupID}
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId, toWhapiGroupId } = require('./phones')
const { post, patch, del, get } = require('./http')
const { extractArray, isWhapiSuccessBody, notImplemented } = require('./parse')

async function archiveChatByFlag(phone, archive, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toWhapiChatId(phone)
  if (!chatId) return false
  try {
    const { ok, data } = await post({
      token: cfg.token,
      endpoint: `/chats/${encodeURIComponent(chatId)}`,
      body: { archive: archive === true },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi archiveChat falhou:', e?.message || e)
    return false
  }
}

async function archiveChat(phone, opts = {}) {
  return archiveChatByFlag(phone, true, opts)
}

async function unarchiveChat(phone, opts = {}) {
  return archiveChatByFlag(phone, false, opts)
}

/** Marca o chat como lido. PATCH { mark_unread: false }. Boolean. */
async function readChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toWhapiChatId(phone)
  if (!chatId) return false
  try {
    const { ok, data } = await patch({
      token: cfg.token,
      endpoint: `/chats/${encodeURIComponent(chatId)}`,
      body: { mark_unread: false },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi readChat falhou:', e?.message || e)
    return false
  }
}

async function deleteChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toWhapiChatId(phone)
  if (!chatId) return false
  try {
    const { ok, data } = await del({
      token: cfg.token,
      endpoint: `/chats/${encodeURIComponent(chatId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi deleteChat falhou:', e?.message || e)
    return false
  }
}

/** Whapi não tem equivalente estável de clearMessages — 501 claro. */
async function clearChatMessages() {
  return notImplemented('clearChatMessages')
}

async function getChats(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await get({ token: cfg.token, endpoint: '/chats' })
    if (!ok) return []
    return extractArray(data, ['chats', 'data', 'list'])
  } catch {
    return []
  }
}

/**
 * Metadados de UM chat específico. GET /chats/{ChatID}.
 * `chat` aceita telefone ou chat id (…@s.whatsapp.net / …@g.us). Retorna { ok, chat } ou { ok:false }.
 */
async function getChat(chat, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const chatId = toWhapiChatId(chat)
  if (!chatId) return { ok: false, error: 'Chat inválido.' }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: `/chats/${encodeURIComponent(chatId)}` })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true, chat: data || null, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler chat (Whapi): ${e?.message || e}` }
  }
}

async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const extraParams = {}
    if (opts.count != null) extraParams.count = String(opts.count)
    if (opts.offset != null) extraParams.offset = String(opts.offset)
    const { ok, data } = await get({ token: cfg.token, endpoint: '/groups', extraParams })
    if (!ok) return []
    return extractArray(data, ['groups', 'data', 'chats', 'list'])
  } catch {
    return []
  }
}

async function getGroup(groupId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !groupId) return null
  const gid = toWhapiGroupId(groupId)
  if (!gid) return null
  try {
    const extraParams = {}
    if (opts.resync === true) extraParams.resync = 'true'
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/groups/${encodeURIComponent(gid)}`,
      extraParams,
    })
    if (!ok || !data || typeof data !== 'object') return null
    const group = data.group && typeof data.group === 'object' ? data.group : data
    return group
  } catch {
    return null
  }
}

/**
 * Ajustes de chat no WhatsApp do celular. PATCH /chats/{ChatID}.
 * Campos: pin (bool), mute_until (unix ms; 0 = desmutar), mark_unread (bool),
 * ephemeral ('none'|'day'|'week'|'quarter'). Só envia o que vier em `patch`. Boolean.
 */
async function patchChat(phone, changes = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toWhapiChatId(phone)
  if (!chatId) return false
  const body = {}
  if (typeof changes.pin === 'boolean') body.pin = changes.pin
  if (changes.mute_until != null) body.mute_until = Number(changes.mute_until)
  if (typeof changes.mark_unread === 'boolean') body.mark_unread = changes.mark_unread
  if (changes.ephemeral != null && ['none', 'day', 'week', 'quarter'].includes(String(changes.ephemeral))) {
    body.ephemeral = String(changes.ephemeral)
  }
  if (!Object.keys(body).length) return false
  try {
    const { ok, data } = await patch({
      token: cfg.token,
      endpoint: `/chats/${encodeURIComponent(chatId)}`,
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi patchChat falhou:', e?.message || e)
    return false
  }
}

/** Fixa/desafixa o chat. Atalho de patchChat({ pin }). */
async function pinChat(phone, pin = true, opts = {}) {
  return patchChat(phone, { pin: pin !== false }, opts)
}

/** Silencia/desmuta o chat. mute=true silencia por ~8h (default) ou opts.muteUntil (unix ms); false desmuta. */
async function muteChat(phone, mute = true, opts = {}) {
  const muteUntil = mute === false
    ? 0
    : (opts?.muteUntil != null ? Number(opts.muteUntil) : Date.now() + 8 * 60 * 60 * 1000)
  return patchChat(phone, { mute_until: muteUntil }, opts)
}

module.exports = {
  archiveChat,
  unarchiveChat,
  readChat,
  clearChatMessages,
  deleteChat,
  getChats,
  getChat,
  getGroups,
  getGroup,
  patchChat,
  pinChat,
  muteChat,
}
