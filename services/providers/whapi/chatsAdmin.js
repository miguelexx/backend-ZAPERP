/**
 * Chat admin Whapi — arquivos próprios (não misturar com UltraMSG).
 * Archive: POST /chats/{ChatID} { archive }
 * Read:    PATCH /chats/{ChatID} { mark_unread: false }
 * Delete:  DELETE /chats/{ChatID}
 * List:    GET /chats · GET /groups · GET /groups/{GroupID}
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId, isGroupJid } = require('./phones')
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

async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await get({ token: cfg.token, endpoint: '/groups' })
    if (!ok) return []
    return extractArray(data, ['groups', 'data', 'chats', 'list'])
  } catch {
    return []
  }
}

async function getGroup(groupId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !groupId) return null
  const gid = String(groupId).trim()
  if (!gid || !isGroupJid(gid)) return null
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/groups/${encodeURIComponent(gid)}`,
    })
    if (!ok || !data || typeof data !== 'object') return null
    const group = data.group && typeof data.group === 'object' ? data.group : data
    return group
  } catch {
    return null
  }
}

module.exports = {
  archiveChat,
  unarchiveChat,
  readChat,
  clearChatMessages,
  deleteChat,
  getChats,
  getGroups,
  getGroup,
}
