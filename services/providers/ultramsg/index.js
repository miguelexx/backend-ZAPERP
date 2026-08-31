/**
 * Adapter UltraMSG — API pública estável.
 * Callers devem continuar usando require('../providers/ultramsg') ou getProvider().
 */

const { toUltramsgPhone, normalizePhone, toLookupChatId, profilePictureChatIdCandidates, contactRecordMatchesChatId, chatMessageCandidatesForLookup, normalizeChatId } = require('./phones')
const { buildBaseUrl, appendToken, get, post, maskTokenInLogs, validateRequiredFields } = require('./http')
const send = require('./send')
const audio = require('./audio')
const contacts = require('./contacts')
const chatsAdmin = require('./chatsAdmin')
const profilePicture = require('./profilePicture')
const chatMessages = require('./chatMessages')
const { uploadMedia } = require('./upload')
const instanceAdmin = require('./instanceAdmin')

module.exports = {
  sendText: send.sendText,
  sendLink: send.sendLink,
  sendImage: send.sendImage,
  sendFile: send.sendFile,
  sendAudio: audio.sendAudio,
  sendVoice: audio.sendVoice,
  sendVideo: send.sendVideo,
  sendReaction: send.sendReaction,
  removeReaction: send.removeReaction,
  sendContact: send.sendContact,
  sendLocation: send.sendLocation,
  sendCall: send.sendCall,
  sendSticker: send.sendSticker,
  deleteMessage: send.deleteMessage,
  resendByStatus: send.resendByStatus,
  resendById: send.resendById,
  clearMessages: send.clearMessages,
  getMessagesStatistics: send.getMessagesStatistics,
  getMessages: send.getMessages,
  archiveChat: chatsAdmin.archiveChat,
  unarchiveChat: chatsAdmin.unarchiveChat,
  readChat: chatsAdmin.readChat,
  clearChatMessages: chatsAdmin.clearChatMessages,
  deleteChat: chatsAdmin.deleteChat,
  getContacts: contacts.getContacts,
  getChats: chatsAdmin.getChats,
  getGroups: chatsAdmin.getGroups,
  getGroup: chatsAdmin.getGroup,
  classifyChatMessagesPage: chatMessages.classifyChatMessagesPage,
  chatMessageCandidatesForLookup,
  profilePictureChatIdCandidates,
  contactRecordMatchesChatId,
  toLookupChatId,
  uploadMedia,
  getProfilePicture: profilePicture.getProfilePicture,
  invalidateNoProfilePictureCache: profilePicture.invalidateNoProfilePictureCache,
  getContactMetadata: contacts.getContactMetadata,
  getChatMessages: chatMessages.getChatMessages,
  configureWebhooks: instanceAdmin.configureWebhooks,
  updateProfilePicture: instanceAdmin.updateProfilePicture,
  updateProfileName: instanceAdmin.updateProfileName,
  updateProfileDescription: instanceAdmin.updateProfileDescription,
  getConnectionStatus: instanceAdmin.getConnectionStatus,
  normalizePhone,
  toUltramsgPhone,
  isConfigured: true,
  buildBaseUrl,
  appendToken,
  get,
  post,
  maskTokenInLogs,
  normalizeChatId,
  validateRequiredFields,
}
