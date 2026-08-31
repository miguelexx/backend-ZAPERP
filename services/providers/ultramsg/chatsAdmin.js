const { toChatIdForChats } = require('./phones')
const { resolveConfig } = require('./config')
const { post, getJson } = require('./http')

/**
 * Arquiva chat. UltraMsg: POST /{instance_id}/chats/archive — body: token, chatId
 */
async function archiveChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/archive', body: { chatId } })
  return ok
}

/**
 * Desarquiva chat. UltraMsg: POST /{instance_id}/chats/unarchive — body: token, chatId
 */
async function unarchiveChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/unarchive', body: { chatId } })
  return ok
}

/**
 * Marca chat como lido. UltraMsg: POST /{instance_id}/chats/read — body: token, chatId
 */
async function readChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/read', body: { chatId } })
  return ok
}

/**
 * Limpa mensagens do chat. UltraMsg: POST /{instance_id}/chats/clearMessages
 * Arquitetura pronta; parâmetros conforme doc quando disponível.
 */
async function clearChatMessages(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/clearMessages', body: { chatId } })
  return ok
}

/**
 * Exclui chat. UltraMsg: POST /{instance_id}/chats/delete — body: token, chatId
 * Arquitetura pronta para uso futuro.
 */
async function deleteChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const chatId = toChatIdForChats(phone)
  if (!chatId) return false
  const { ok } = await post({ ...cfg, endpoint: '/chats/delete', body: { chatId } })
  return ok
}

/**
 * Lista todos os chats (conversas individuais e grupos).
 * UltraMsg: GET /{instance_id}/chats — retorna lista completa.
 * Aceita resposta como array direto ou objeto com data/chats.
 */
async function getChats(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/chats' })
    if (!ok) return []
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.data ?? data.chats ?? data.list
      if (Array.isArray(arr)) return arr
    }
    return []
  } catch {
    return []
  }
}

/**
 * Lista grupos. UltraMsg: GET /{instance_id}/groups
 * Aceita resposta como array direto ou objeto com data/groups.
 */
async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await getJson({ ...cfg, endpoint: '/groups' })
    if (!ok) return []
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.data ?? data.groups ?? data.chats
      if (Array.isArray(arr)) return arr
    }
    return []
  } catch {
    return []
  }
}

/**
 * Busca detalhes de um grupo. UltraMsg: GET /{instance_id}/groups/group?groupId=XXX
 */
async function getGroup(groupId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !groupId) return null
  try {
    const gid = String(groupId).trim()
    if (!gid || !gid.endsWith('@g.us')) return null
    const { ok, data } = await getJson({ ...cfg, endpoint: '/groups/group', extraParams: { groupId: gid } })
    if (!ok || !data || typeof data !== 'object') return null
    return data
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
