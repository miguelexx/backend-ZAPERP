/**
 * Adapter Whapi Cloud — API pública estável (mesmos NOMES do contrato interno da UltraMSG).
 * Callers usam getProvider({ provider: 'whapi' }). NÃO importa nada da pasta ultramsg.
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const send = require('./send')
const messages = require('./messages')
const chatsAdmin = require('./chatsAdmin')
const contacts = require('./contacts')
const chatMessages = require('./chatMessages')
const instanceAdmin = require('./instanceAdmin')
const presence = require('./presence')
const blacklist = require('./blacklist')
const queries = require('./queries')
const { uploadMedia } = require('./upload')
const { buildBaseUrl, maskTokenInLogs, validateRequiredFields } = require('./http')
const { toWhapiRecipient, toWhapiChatId, recipientCandidates } = require('./phones')

module.exports = {
  sendText: send.sendText,
  sendLink: send.sendLink,
  sendInteractive: send.sendInteractive,
  sendImage: send.sendImage,
  sendFile: send.sendFile,
  sendVideo: send.sendVideo,
  sendSticker: send.sendSticker,
  sendAudio: send.sendAudio,
  sendVoice: send.sendVoice,
  sendContact: send.sendContact,
  sendLocation: send.sendLocation,
  sendReaction: send.sendReaction,
  removeReaction: send.removeReaction,
  sendCall: send.sendCall,
  forwardMessage: send.forwardMessage,

  deleteMessage: messages.deleteMessage,
  editMessage: messages.editMessage,
  markMessageAsRead: messages.markMessageAsRead,
  markMessageAsPlayed: messages.markMessageAsPlayed,
  pinMessage: messages.pinMessage,
  starMessage: messages.starMessage,
  getMessages: messages.getMessages,

  archiveChat: chatsAdmin.archiveChat,
  unarchiveChat: chatsAdmin.unarchiveChat,
  readChat: chatsAdmin.readChat,
  clearChatMessages: chatsAdmin.clearChatMessages,
  deleteChat: chatsAdmin.deleteChat,
  getChats: chatsAdmin.getChats,
  getGroups: chatsAdmin.getGroups,
  getGroup: chatsAdmin.getGroup,
  patchChat: chatsAdmin.patchChat,
  pinChat: chatsAdmin.pinChat,
  muteChat: chatsAdmin.muteChat,

  getContacts: contacts.getContacts,
  getContactMetadata: contacts.getContactMetadata,
  getProfilePicture: contacts.getProfilePicture,
  invalidateNoProfilePictureCache: contacts.invalidateNoProfilePictureCache,
  checkPhones: contacts.checkPhones,
  getContactAbout: contacts.getContactAbout,
  addContact: contacts.addContact,
  getIdByLid: contacts.getIdByLid,
  getLidById: contacts.getLidById,
  getChatMessages: chatMessages.getChatMessages,
  uploadMedia,

  // Presença (digitando…/gravando…) e presença da própria conta
  sendPresence: presence.sendPresence,
  setMePresence: presence.setMePresence,

  // Blacklist (bloquear/desbloquear contato — opt-out com efeito real)
  blockContact: blacklist.blockContact,
  unblockContact: blacklist.unblockContact,
  getBlacklist: blacklist.getBlacklist,

  getConnectionStatus: instanceAdmin.getConnectionStatus,
  configureWebhooks: instanceAdmin.configureWebhooks,
  getLoginQr: instanceAdmin.getLoginQr,
  getLoginCode: instanceAdmin.getLoginCode,
  logoutUser: instanceAdmin.logoutUser,
  updateProfilePicture: instanceAdmin.updateProfilePicture,
  updateProfileName: instanceAdmin.updateProfileName,
  updateProfileDescription: instanceAdmin.updateProfileDescription,

  resendByStatus: queries.resendByStatus,
  resendById: queries.resendById,
  clearMessages: queries.clearMessages,
  getMessagesStatistics: queries.getMessagesStatistics,

  toWhapiRecipient,
  toWhapiChatId,
  recipientCandidates,
  buildBaseUrl,
  maskTokenInLogs,
  validateRequiredFields,
  isConfigured: true,
  provider: 'whapi',
}
