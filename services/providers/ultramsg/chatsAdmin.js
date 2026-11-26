const { toChatIdForChats, profilePictureChatIdCandidates } = require('./phones')
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
  if (!cfg) return { ok: false, error: 'Instância UltraMSG não configurada' }

  // Mesmo bug que a Whapi teve (doc 34 §8.2): `toChatIdForChats` passa por `toZapiSendFormat`,
  // que INSERE o 9º dígito — e o chat BR costuma viver no WhatsApp com 12 dígitos. Com um
  // endereço só, apagávamos um JID que não existe. Agora tenta o JID real e as variantes de
  // identidade (`possiblePhonesForWhatsappIdentity`, com a guarda de celular). Contato com DOIS
  // chats (±9º) tem os dois apagados. A forma de envio (`toChatIdForChats`) fica DE FORA de
  // propósito: num FIXO ela inventa o "celular" 5534934238595 a partir de 553434238595 — e como
  // aqui apagamos todos os endereços, um palpite que existisse seria a conversa de outra pessoa.
  const candidatos = profilePictureChatIdCandidates(phone)
  if (!candidatos.length) return { ok: false, error: 'Chat inválido.' }

  const apagados = []
  let ultimoErro = null
  for (const chatId of candidatos.slice(0, 3)) {
    try {
      const { ok, status, data, text } = await post({ ...cfg, endpoint: '/chats/delete', body: { chatId } })
      // UltraMSG responde 200 com `{ error }` quando recusa (instância parada, chat inexistente…):
      // HTTP ok sozinho NÃO é sucesso.
      const erroCorpo = data && typeof data === 'object' && data.error != null && data.error !== false
        ? String(data.error)
        : null
      if (ok && !erroCorpo) {
        apagados.push(chatId)
        continue
      }
      ultimoErro = { chatId, httpStatus: status, error: erroCorpo || String(text || `HTTP ${status}`).slice(0, 160) }
    } catch (e) {
      ultimoErro = { chatId, error: e?.message || String(e) }
    }
  }
  if (apagados.length) return { ok: true, chatId: apagados[0], apagados }
  console.warn('❌ UltraMSG deleteChat não apagou nenhum endereço:', candidatos.join(' · '), ultimoErro?.error || '')
  return { ok: false, ...(ultimoErro || {}) }
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
