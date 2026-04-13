/**
 * Repositório — chat interno (Supabase). Sem regras de negócio.
 */

const supabase = require('../config/supabase')
const { TABLES, RPC, MESSAGE_TYPE } = require('./internalChatConstants')

const MESSAGE_SELECT =
  'id, conversation_id, company_id, sender_user_id, message_type, content, media_url, file_name, mime_type, file_size, payload, is_deleted, created_at, updated_at'

/**
 * @param {number} companyId
 * @param {number} userIdA
 * @param {number} userIdB
 * @returns {Promise<{ ok: true, conversation_id: number, created: boolean } | { ok: false, error: string, code?: string }>}
 */
async function ensurePairConversation(companyId, userIdA, userIdB) {
  const { data, error } = await supabase.rpc(RPC.ENSURE_PAIR_CONVERSATION, {
    p_company_id: companyId,
    p_user_a: userIdA,
    p_user_b: userIdB,
  })

  if (error) {
    return {
      ok: false,
      error: error.message || 'Erro ao garantir conversa interna',
      code: error.code,
    }
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const conversation_id = Number(data.conversation_id)
    const created = !!data.created
    if (Number.isFinite(conversation_id)) {
      return { ok: true, conversation_id, created }
    }
  }

  const legacyId = typeof data === 'number' ? data : Number(data)
  if (Number.isFinite(legacyId)) {
    return { ok: true, conversation_id: legacyId, created: false }
  }

  return { ok: false, error: 'Resposta inválida do banco ao criar conversa' }
}

/**
 * @param {number} companyId
 * @param {number} userId
 * @returns {Promise<{ ok: true, rows: object[] } | { ok: false, error: string }>}
 */
async function rpcListConversations(companyId, userId) {
  const { data, error } = await supabase.rpc(RPC.LIST_CONVERSATIONS, {
    p_company_id: companyId,
    p_user_id: userId,
  })

  if (error) {
    return { ok: false, error: error.message, code: error.code }
  }
  return { ok: true, rows: Array.isArray(data) ? data : [] }
}

/**
 * @param {number} companyId
 * @param {number} excludeUserId — não obrigatório
 * @returns {Promise<{ ok: true, rows: object[] } | { ok: false, error: string }>}
 */
async function listActiveEmployees(companyId, excludeUserId) {
  let q = supabase
    .from(TABLES.USUARIOS)
    .select('id, nome, email')
    .eq('company_id', companyId)
    .eq('ativo', true)
    .order('nome', { ascending: true })

  const ex = Number(excludeUserId)
  if (Number.isFinite(ex) && ex > 0) {
    q = q.neq('id', ex)
  }

  const { data, error } = await q
  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, rows: data || [] }
}

/**
 * @param {number} companyId
 * @param {number} userId
 * @returns {Promise<{ ok: true, row: object|null } | { ok: false, error: string }>}
 */
async function getUserInCompany(companyId, userId) {
  const { data, error } = await supabase
    .from(TABLES.USUARIOS)
    .select('id, nome, email, company_id, ativo')
    .eq('id', userId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, row: data || null }
}

/**
 * @param {number} conversationId
 * @param {number} companyId
 * @returns {Promise<{ ok: true, row: object|null } | { ok: false, error: string }>}
 */
async function getConversationById(conversationId, companyId) {
  const { data, error } = await supabase
    .from(TABLES.CONVERSATIONS)
    .select('id, company_id, participant_pair_key, created_at, updated_at, last_message_at')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, row: data || null }
}

/**
 * @param {number} conversationId
 * @param {number} companyId
 * @param {number} userId
 * @returns {Promise<{ ok: true, isParticipant: boolean } | { ok: false, error: string }>}
 */
async function isUserParticipant(conversationId, companyId, userId) {
  const { data, error } = await supabase
    .from(TABLES.PARTICIPANTS)
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, isParticipant: !!data }
}

/**
 * @param {number} conversationId
 * @param {number} companyId
 * @returns {Promise<{ ok: true, rows: object[] } | { ok: false, error: string }>}
 */
async function listParticipants(conversationId, companyId) {
  const { data, error } = await supabase
    .from(TABLES.PARTICIPANTS)
    .select('id, user_id, conversation_id, company_id, created_at')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('user_id', { ascending: true })

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, rows: data || [] }
}

/**
 * @param {object} payload
 * @returns {Promise<{ ok: true, row: object } | { ok: false, error: string, code?: string }>}
 */
async function insertMessage(payload) {
  const { data, error } = await supabase
    .from(TABLES.MESSAGES)
    .insert({
      ...payload,
      message_type: payload.message_type || MESSAGE_TYPE.TEXT,
    })
    .select(MESSAGE_SELECT)
    .single()

  if (error) {
    return { ok: false, error: error.message, code: error.code }
  }
  return { ok: true, row: data }
}

/**
 * @param {number} conversationId
 * @param {number} companyId
 * @param {{ beforeId: number|null, limit: number }} opts
 */
async function listMessagesPage(conversationId, companyId, opts) {
  const { beforeId, limit } = opts
  let q = supabase
    .from(TABLES.MESSAGES)
    .select(
      'id, sender_user_id, message_type, content, media_url, file_name, mime_type, file_size, payload, is_deleted, created_at'
    )
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .limit(limit)

  if (beforeId != null && Number.isFinite(beforeId)) {
    q = q.lt('id', beforeId)
  }

  const { data, error } = await q
  if (error) {
    return { ok: false, error: error.message }
  }
  const rows = data || []
  const chronological = [...rows].reverse()
  let next_before_id = null
  if (rows.length === limit) {
    const oldest = chronological[0]
    if (oldest && oldest.id != null) {
      next_before_id = oldest.id
    }
  }
  return { ok: true, messages: chronological, next_before_id }
}

/**
 * Maior id de mensagem na conversa (para marcar tudo lido).
 * @param {number} conversationId
 * @param {number} companyId
 */
async function getLatestMessageId(conversationId, companyId) {
  const { data, error } = await supabase
    .from(TABLES.MESSAGES)
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .eq('is_deleted', false)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, id: data?.id != null ? Number(data.id) : null }
}

/**
 * @param {number} messageId
 * @param {number} conversationId
 * @param {number} companyId
 */
async function messageBelongsToConversation(messageId, conversationId, companyId) {
  const { data, error } = await supabase
    .from(TABLES.MESSAGES)
    .select('id')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, okRow: !!data }
}

/**
 * @param {object} payload
 * @returns {Promise<{ ok: true, row: object } | { ok: false, error: string, code?: string }>}
 */
async function upsertReadState(payload) {
  const { data, error } = await supabase
    .from(TABLES.READS)
    .upsert(payload, { onConflict: 'conversation_id,user_id' })
    .select()
    .single()

  if (error) {
    return { ok: false, error: error.message, code: error.code }
  }
  return { ok: true, row: data }
}

module.exports = {
  ensurePairConversation,
  rpcListConversations,
  listActiveEmployees,
  getUserInCompany,
  getConversationById,
  isUserParticipant,
  listParticipants,
  insertMessage,
  listMessagesPage,
  getLatestMessageId,
  messageBelongsToConversation,
  upsertReadState,
}
