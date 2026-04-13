/**
 * Constantes do chat interno (tabelas e RPC).
 */

const TABLES = {
  CONVERSATIONS: 'internal_conversations',
  PARTICIPANTS: 'internal_conversation_participants',
  MESSAGES: 'internal_messages',
  READS: 'internal_conversation_reads',
  USUARIOS: 'usuarios',
  CLIENTES: 'clientes',
}

const RPC = {
  ENSURE_PAIR_CONVERSATION: 'internal_chat_ensure_pair_conversation',
  LIST_CONVERSATIONS: 'internal_chat_list_conversations',
}

/** Tipos persistidos em internal_messages.message_type */
const MESSAGE_TYPE = {
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document',
  AUDIO: 'audio',
  VIDEO: 'video',
  LOCATION: 'location',
  CONTACT: 'contact',
  STICKER: 'sticker',
}

const ALL_MESSAGE_TYPES = Object.values(MESSAGE_TYPE)

const MEDIA_MESSAGE_TYPES = new Set([
  MESSAGE_TYPE.IMAGE,
  MESSAGE_TYPE.DOCUMENT,
  MESSAGE_TYPE.AUDIO,
  MESSAGE_TYPE.VIDEO,
  MESSAGE_TYPE.STICKER,
])

const MAX_CONTENT_LENGTH = 8000
const MAX_ADDRESS_LENGTH = 500
const MAX_CONTACT_NAME_LENGTH = 200
const MAX_PHONE_LENGTH = 40
const MAX_ORG_LENGTH = 200
/** Máximo de linhas (pessoas ou número+pessoa) numa mensagem de contato */
const MAX_CONTACTS_PER_MESSAGE = 50
/** Máximo de telefones num mesmo cartão (name + phones[]) */
const MAX_PHONES_PER_CARD = 25

module.exports = {
  TABLES,
  RPC,
  MESSAGE_TYPE,
  ALL_MESSAGE_TYPES,
  MEDIA_MESSAGE_TYPES,
  MAX_CONTENT_LENGTH,
  MAX_ADDRESS_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_ORG_LENGTH,
  MAX_CONTACTS_PER_MESSAGE,
  MAX_PHONES_PER_CARD,
}
