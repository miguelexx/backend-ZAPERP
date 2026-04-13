/**
 * Constantes do chat interno (tabelas e RPC).
 */

const TABLES = {
  CONVERSATIONS: 'internal_conversations',
  PARTICIPANTS: 'internal_conversation_participants',
  MESSAGES: 'internal_messages',
  READS: 'internal_conversation_reads',
  USUARIOS: 'usuarios',
}

const RPC = {
  ENSURE_PAIR_CONVERSATION: 'internal_chat_ensure_pair_conversation',
  LIST_CONVERSATIONS: 'internal_chat_list_conversations',
}

const MESSAGE_TYPE = {
  TEXT: 'text',
}

const MAX_CONTENT_LENGTH = 8000

module.exports = {
  TABLES,
  RPC,
  MESSAGE_TYPE,
  MAX_CONTENT_LENGTH,
}
