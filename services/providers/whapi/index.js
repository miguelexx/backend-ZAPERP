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
const queries = require('./queries')
const { uploadMedia } = require('./upload')
const { buildBaseUrl, maskTokenInLogs, validateRequiredFields } = require('./http')
const { toWhapiRecipient, toWhapiChatId, recipientCandidates } = require('./phones')

module.exports = {
  sendText: send.sendText,
  sendLink: send.sendLink,
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

  deleteMessage: messages.deleteMessage,
  editMessage: messages.editMessage,
  markMessageAsRead: messages.markMessageAsRead,
  getMessages: messages.getMessages,

  archiveChat: chatsAdmin.archiveChat,
  unarchiveChat: chatsAdmin.unarchiveChat,
  readChat: chatsAdmin.readChat,
  clearChatMessages: chatsAdmin.clearChatMessages,
  deleteChat: chatsAdmin.deleteChat,
  getChats: chatsAdmin.getChats,
  getGroups: chatsAdmin.getGroups,
  getGroup: chatsAdmin.getGroup,

  getContacts: contacts.getContacts,
  getContactMetadata: contacts.getContactMetadata,
  getProfilePicture: contacts.getProfilePicture,
  invalidateNoProfilePictureCache: contacts.invalidateNoProfilePictureCache,
  getChatMessages: chatMessages.getChatMessages,
  uploadMedia,

  getConnectionStatus: instanceAdmin.getConnectionStatus,
  configureWebhooks: instanceAdmin.configureWebhooks,
  getLoginQr: instanceAdmin.getLoginQr,
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
