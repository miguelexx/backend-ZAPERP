/**
 * Consultas Whapi (contatos/chats/grupos/histórico/foto/upload) — STUBS 501 até a Fase D.
 * IMPORTANTE: quando alguém apertar "sincronizar" numa instância Whapi, tem que cair AQUI
 * (501 claro), NUNCA no serviço UltraMSG por engano. Ver doc 25 §6 (Fase D).
 */

function stub(method) {
  return async () => ({ ok: false, notImplemented: true, httpStatus: 501, error: `whapi.${method} não implementado (Fase D)` })
}

module.exports = {
  getContacts: stub('getContacts'),
  getContactMetadata: stub('getContactMetadata'),
  getChats: stub('getChats'),
  getGroups: stub('getGroups'),
  getGroup: stub('getGroup'),
  getChatMessages: stub('getChatMessages'),
  getProfilePicture: stub('getProfilePicture'),
  archiveChat: stub('archiveChat'),
  unarchiveChat: stub('unarchiveChat'),
  readChat: stub('readChat'),
  clearChatMessages: stub('clearChatMessages'),
  deleteChat: stub('deleteChat'),
}
