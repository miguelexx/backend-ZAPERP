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
const channel = require('./channel')
const limits = require('./limits')
const labels = require('./labels')
const business = require('./business')
const catalog = require('./catalog')
const groups = require('./groups')
const { uploadMedia, getMediaFiles, getMedia, deleteMedia } = require('./upload')
const { buildBaseUrl, maskTokenInLogs, validateRequiredFields } = require('./http')
const { toWhapiRecipient, toWhapiChatId, toWhapiGroupId, recipientCandidates } = require('./phones')

module.exports = {
  sendText: send.sendText,
  sendLink: send.sendLink,
  sendInteractive: send.sendInteractive,
  sendPoll: send.sendPoll,
  sendQuiz: send.sendQuiz,
  sendQuestion: send.sendQuestion,
  sendImage: send.sendImage,
  sendFile: send.sendFile,
  sendVideo: send.sendVideo,
  sendSticker: send.sendSticker,
  sendAudio: send.sendAudio,
  sendVoice: send.sendVoice,
  sendGif: send.sendGif,
  sendShortVideo: send.sendShortVideo,
  sendPtv: send.sendPtv,
  sendContact: send.sendContact,
  sendLocation: send.sendLocation,
  sendLiveLocation: send.sendLiveLocation,
  sendReaction: send.sendReaction,
  removeReaction: send.removeReaction,
  sendCall: send.sendCall,
  forwardMessage: send.forwardMessage,
  sendProduct: send.sendProduct,
  sendCatalog: send.sendCatalog,

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
  getChat: chatsAdmin.getChat,
  getGroups: chatsAdmin.getGroups,
  getGroup: chatsAdmin.getGroup,
  createGroup: groups.createGroup,
  acceptGroupInvite: groups.acceptGroupInvite,
  updateGroupInfo: groups.updateGroupInfo,
  leaveGroup: groups.leaveGroup,
  updateGroupSetting: groups.updateGroupSetting,
  getGroupInvite: groups.getGroupInvite,
  revokeGroupInvite: groups.revokeGroupInvite,
  addGroupParticipant: groups.addGroupParticipant,
  removeGroupParticipant: groups.removeGroupParticipant,
  promoteToGroupAdmin: groups.promoteToGroupAdmin,
  demoteGroupAdmin: groups.demoteGroupAdmin,
  getGroupIcon: groups.getGroupIcon,
  setGroupIcon: groups.setGroupIcon,
  deleteGroupIcon: groups.deleteGroupIcon,
  sendGroupInvite: groups.sendGroupInvite,
  getGroupMetadataByInviteCode: groups.getGroupMetadataByInviteCode,
  getGroupApplicationsList: groups.getGroupApplicationsList,
  approveGroupApplication: groups.approveGroupApplication,
  rejectGroupApplication: groups.rejectGroupApplication,
  patchChat: chatsAdmin.patchChat,
  pinChat: chatsAdmin.pinChat,
  muteChat: chatsAdmin.muteChat,

  getContacts: contacts.getContacts,
  getContactMetadata: contacts.getContactMetadata,
  getProfilePicture: contacts.getProfilePicture,
  getContactProfile: contacts.getContactProfile,
  invalidateNoProfilePictureCache: contacts.invalidateNoProfilePictureCache,
  checkPhones: contacts.checkPhones,
  getContactAbout: contacts.getContactAbout,
  addContact: contacts.addContact,
  getIdByLid: contacts.getIdByLid,
  getLidById: contacts.getLidById,
  getLidByIds: contacts.getLidByIds,
  checkExist: contacts.checkExist,
  editContact: contacts.editContact,
  deleteContact: contacts.deleteContact,
  getChatMessages: chatMessages.getChatMessages,
  uploadMedia,
  getMediaFiles,
  getMedia,
  deleteMedia,

  // Presença (digitando…/gravando…) e presença da própria conta
  sendPresence: presence.sendPresence,
  setMePresence: presence.setMePresence,
  // Presença do contato (online/visto por último) — exige subscribePresence antes
  subscribePresence: presence.subscribePresence,
  getPresence: presence.getPresence,

  // Blacklist (bloquear/desbloquear contato — opt-out com efeito real)
  blockContact: blacklist.blockContact,
  unblockContact: blacklist.unblockContact,
  getBlacklist: blacklist.getBlacklist,

  getConnectionStatus: instanceAdmin.getConnectionStatus,
  configureWebhooks: instanceAdmin.configureWebhooks,
  getLoginQr: instanceAdmin.getLoginQr,
  getLoginQrBase64: instanceAdmin.getLoginQrBase64,
  getLoginQrRowData: instanceAdmin.getLoginQrRowData,
  getLoginCode: instanceAdmin.getLoginCode,
  logoutUser: instanceAdmin.logoutUser,
  getUserProfile: instanceAdmin.getUserProfile,
  updateUserProfile: instanceAdmin.updateUserProfile,
  updateProfilePicture: instanceAdmin.updateProfilePicture,
  updateProfileName: instanceAdmin.updateProfileName,
  updateProfileDescription: instanceAdmin.updateProfileDescription,
  getAccountRegistrationDate: instanceAdmin.getAccountRegistrationDate,
  getUsername: instanceAdmin.getUsername,
  setUsername: instanceAdmin.setUsername,

  getChannelSettings: channel.getChannelSettings,
  updateChannelSettings: channel.updateChannelSettings,
  resetChannelSettings: channel.resetChannelSettings,
  getAllowedEvents: channel.getAllowedEvents,
  testWebhook: channel.testWebhook,
  getLimits: channel.getLimits,

  // Limites anti-ban (read-only) — freia o disparo antes de queimar o número
  getNewChatLimit: limits.getNewChatLimit,
  getReachoutTimelock: limits.getReachoutTimelock,

  // Labels do WhatsApp Business — casam com tags/kanban do CRM
  getLabels: labels.getLabels,
  createLabel: labels.createLabel,
  renameLabel: labels.renameLabel,
  deleteLabel: labels.deleteLabel,
  getLabelAssociations: labels.getLabelAssociations,
  addLabelAssociation: labels.addLabelAssociation,
  deleteLabelAssociation: labels.deleteLabelAssociation,

  // Perfil WhatsApp Business — cartão da empresa (endereço, horário, sites…)
  getBusinessProfile: business.getBusinessProfile,
  editBusinessProfile: business.editBusinessProfile,

  // Catálogo WhatsApp Business — vitrine da empresa (produtos + coleções), só leitura
  getCatalogProducts: catalog.getProducts,
  getCatalogProduct: catalog.getProduct,
  getCatalogCollections: catalog.getCollections,
  getCatalogCollection: catalog.getCollection,
  getCatalogCollectionProducts: catalog.getCollectionProducts,
  getContactCatalogProducts: catalog.getContactProducts,
  createCatalogProduct: catalog.createProduct,
  updateCatalogProduct: catalog.updateProduct,
  deleteCatalogProduct: catalog.deleteProduct,
  createCatalogCollection: catalog.createCollection,
  editCatalogCollection: catalog.editCollection,
  deleteCatalogCollection: catalog.deleteCollection,

  resendByStatus: queries.resendByStatus,
  resendById: queries.resendById,
  clearMessages: queries.clearMessages,
  getMessagesStatistics: queries.getMessagesStatistics,

  toWhapiRecipient,
  toWhapiChatId,
  toWhapiGroupId,
  recipientCandidates,
  buildBaseUrl,
  maskTokenInLogs,
  validateRequiredFields,
  isConfigured: true,
  provider: 'whapi',
}
