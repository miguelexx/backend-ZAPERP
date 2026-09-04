/**
 * Adapter Whapi Cloud — API pública estável (mesmos NOMES do contrato interno da UltraMSG).
 * Callers usam getProvider({ provider: 'whapi' }). NÃO importa nada da pasta ultramsg.
 * Fase B: sendText/mídia/reação/contato/localização + uploadMedia + getConnectionStatus.
 * Fase C (parcial): configureWebhooks real (PATCH /settings); getLoginQr ainda 501.
 * Consultas/sync (getContacts/…) continuam stub 501 até a Fase D.
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const send = require('./send')
const instanceAdmin = require('./instanceAdmin')
const queries = require('./queries')
const { uploadMedia } = require('./upload')
const { buildBaseUrl, maskTokenInLogs, validateRequiredFields } = require('./http')
const { toWhapiRecipient, recipientCandidates } = require('./phones')

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
  deleteMessage: send.deleteMessage,

  // Chat admin (Fase B/D)
  archiveChat: queries.archiveChat,
  unarchiveChat: queries.unarchiveChat,
  readChat: queries.readChat,
  clearChatMessages: queries.clearChatMessages,
  deleteChat: queries.deleteChat,

  // Consultas/sync (Fase D — 501 claro, nunca cair no UltraMSG)
  getContacts: queries.getContacts,
  getContactMetadata: queries.getContactMetadata,
  getChats: queries.getChats,
  getGroups: queries.getGroups,
  getGroup: queries.getGroup,
  getChatMessages: queries.getChatMessages,
  getProfilePicture: queries.getProfilePicture,
  uploadMedia,

  // Admin instância/canal (Fase A: status; Fase C: QR/webhooks)
  getConnectionStatus: instanceAdmin.getConnectionStatus,
  configureWebhooks: instanceAdmin.configureWebhooks,
  getLoginQr: instanceAdmin.getLoginQr,

  // Utilitários
  toWhapiRecipient,
  recipientCandidates,
  buildBaseUrl,
  maskTokenInLogs,
  validateRequiredFields,
  isConfigured: true,
  provider: 'whapi',
}
