/**
 * Regras de negócio — chat interno (isolado do WhatsApp).
 */

const repo = require('../repositories/internalChatRepository')
const {
  assertPositiveCompanyId,
  validatePairRequest,
  validateMessageContent,
  validateMessageType,
  parseMessagesPagination,
  parseOptionalLastReadMessageId,
} = require('../validators/internalChatValidators')
const presence = require('../socket/internalChatPresence')
const internalChatSocket = require('../socket/internalChatSocket')

/**
 * @param {object|null} row
 * @param {number} userId
 */
function mapPeerUser(row, userId) {
  if (!row) {
    return {
      id: userId,
      name: null,
      email: null,
      avatar: null,
      ...presence.snapshot(userId),
    }
  }
  const id = Number(row.id)
  return {
    id,
    name: row.nome ?? null,
    email: row.email ?? null,
    avatar: row.avatar_url ?? row.avatar ?? null,
    ...presence.snapshot(id),
  }
}

/**
 * @param {import('socket.io').Server|null|undefined} io
 * @param {number} companyId
 * @param {number} currentUserId
 * @param {number} targetUserId
 */
async function createOrGetConversation(io, companyId, currentUserId, targetUserId) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const cur = Number(currentUserId)
  const tgt = Number(targetUserId)
  if (!Number.isFinite(cur) || cur <= 0) {
    return { ok: false, error: 'Usuário autenticado inválido', status: 401 }
  }
  if (!Number.isFinite(tgt) || tgt <= 0) {
    return { ok: false, error: 'target_user_id inválido', status: 400 }
  }

  const self = await repo.getUserInCompany(companyId, cur)
  if (!self.ok) return { ok: false, error: self.error, status: 500 }
  if (!self.row || self.row.ativo === false) {
    return { ok: false, error: 'Usuário não encontrado ou inativo', status: 403 }
  }

  const other = await repo.getUserInCompany(companyId, tgt)
  if (!other.ok) return { ok: false, error: other.error, status: 500 }
  if (!other.row || other.row.ativo === false) {
    return { ok: false, error: 'Colaborador não encontrado ou inativo', status: 404 }
  }

  const v = validatePairRequest(companyId, cur, tgt)
  if (!v.ok) return { ok: false, error: v.error, status: 400 }

  const ensured = await repo.ensurePairConversation(companyId, cur, tgt)
  if (!ensured.ok) {
    const msg = String(ensured.error || '')
    const st = /inativo|distintos|próprio|mesma empresa|não encontrado/i.test(msg) ? 400 : 500
    return { ok: false, error: msg || 'Erro ao criar conversa', status: st }
  }

  const conv = await repo.getConversationById(ensured.conversation_id, companyId)
  if (!conv.ok || !conv.row) {
    return { ok: false, error: 'Conversa não encontrada após criação', status: 500 }
  }

  const peerRow = tgt === cur ? null : other.row
  const peer = mapPeerUser(peerRow, tgt)

  if (io && ensured.created) {
    const ev = internalChatSocket.INTERNAL_CHAT_EVENTS.CONVERSATION_CREATED
    io.internalChatEmitUser(cur, ev, {
      conversation_id: ensured.conversation_id,
      peer_user_id: tgt,
      created: true,
    })
    io.internalChatEmitUser(tgt, ev, {
      conversation_id: ensured.conversation_id,
      peer_user_id: cur,
      created: true,
    })
  }

  return {
    ok: true,
    created: !!ensured.created,
    data: {
      conversation: {
        id: conv.row.id,
        participant_pair_key: conv.row.participant_pair_key,
        last_message_at: conv.row.last_message_at,
        updated_at: conv.row.updated_at,
        created_at: conv.row.created_at,
        peer,
      },
    },
  }
}

/**
 * @param {number} companyId
 * @param {number} currentUserId
 */
async function listEmployees(companyId, currentUserId) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const res = await repo.listActiveEmployees(companyId, currentUserId)
  if (!res.ok) return { ok: false, error: res.error, status: 500 }

  const ids = res.rows.map((r) => r.id)
  const pres = presence.snapshotsForIds(ids)

  const employees = res.rows.map((r) => {
    const id = Number(r.id)
    const p = pres[String(id)] || presence.snapshot(id)
    return {
      id,
      name: r.nome ?? null,
      email: r.email ?? null,
      avatar: null,
      is_online: p.is_online,
      last_seen: p.last_seen,
    }
  })

  return { ok: true, data: { employees } }
}

/**
 * @param {number} companyId
 * @param {number} currentUserId
 */
async function listConversations(companyId, currentUserId) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(currentUserId)
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, error: 'Usuário inválido', status: 401 }
  }

  const res = await repo.rpcListConversations(companyId, uid)
  if (!res.ok) {
    return { ok: false, error: res.error, status: 500 }
  }

  const peerIds = res.rows.map((r) => r.peer_id).filter((x) => x != null)
  const pres = presence.snapshotsForIds(peerIds)

  const conversations = res.rows.map((r) => {
    const peerId = r.peer_id != null ? Number(r.peer_id) : null
    const p = peerId != null ? (pres[String(peerId)] || presence.snapshot(peerId)) : { is_online: false, last_seen: null }
    const lastMessage = r.last_message_id != null
      ? {
          id: Number(r.last_message_id),
          content: r.last_message_content,
          sender_user_id: r.last_message_sender_id != null ? Number(r.last_message_sender_id) : null,
          created_at: r.last_message_created_at,
          is_deleted: !!r.last_message_is_deleted,
        }
      : null

    return {
      id: Number(r.conversation_id),
      participant_pair_key: r.participant_pair_key,
      last_message_at: r.last_message_at,
      updated_at: r.updated_at,
      unread_count: Number(r.unread_count) || 0,
      peer: peerId != null
        ? {
            id: peerId,
            name: r.peer_nome ?? null,
            email: r.peer_email ?? null,
            avatar: null,
            is_online: p.is_online,
            last_seen: p.last_seen,
          }
        : null,
      last_message: lastMessage,
    }
  })

  return { ok: true, data: { conversations } }
}

/**
 * @param {number} companyId
 * @param {number} conversationId
 * @param {number} currentUserId
 * @param {Record<string, unknown>} query
 */
async function listMessages(companyId, conversationId, currentUserId, query) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(currentUserId)
  const cid = Number(conversationId)
  if (!Number.isFinite(uid) || !Number.isFinite(cid)) {
    return { ok: false, error: 'Parâmetros inválidos', status: 400 }
  }

  const part = await repo.isUserParticipant(cid, companyId, uid)
  if (!part.ok) return { ok: false, error: part.error, status: 500 }
  if (!part.isParticipant) {
    return { ok: false, error: 'Acesso negado à conversa', status: 403 }
  }

  const { limit, before_id } = parseMessagesPagination(query || {})
  const page = await repo.listMessagesPage(cid, companyId, { beforeId: before_id, limit })
  if (!page.ok) return { ok: false, error: page.error, status: 500 }

  return {
    ok: true,
    data: {
      messages: page.messages,
      next_before_id: page.next_before_id,
      limit,
    },
  }
}

/**
 * @param {import('socket.io').Server|null|undefined} io
 * @param {number} companyId
 * @param {number} conversationId
 * @param {number} currentUserId
 * @param {object} body
 */
async function sendMessage(io, companyId, conversationId, currentUserId, body) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(currentUserId)
  const cid = Number(conversationId)
  if (!Number.isFinite(uid) || !Number.isFinite(cid)) {
    return { ok: false, error: 'Parâmetros inválidos', status: 400 }
  }

  const part = await repo.isUserParticipant(cid, companyId, uid)
  if (!part.ok) return { ok: false, error: part.error, status: 500 }
  if (!part.isParticipant) {
    return { ok: false, error: 'Acesso negado à conversa', status: 403 }
  }

  const tv = validateMessageType(body?.message_type)
  if (!tv.ok) return { ok: false, error: tv.error, status: 400 }

  const mv = validateMessageContent(body?.content)
  if (!mv.ok) return { ok: false, error: mv.error, status: 400 }

  const ins = await repo.insertMessage({
    conversation_id: cid,
    company_id: companyId,
    sender_user_id: uid,
    message_type: tv.message_type,
    content: mv.content,
  })
  if (!ins.ok) {
    return { ok: false, error: ins.error, status: 500 }
  }

  const participants = await repo.listParticipants(cid, companyId)
  const userIds = participants.ok ? participants.rows.map((p) => p.user_id) : []

  if (io && userIds.length) {
    const ev = internalChatSocket.INTERNAL_CHAT_EVENTS.MESSAGE_CREATED
    io.internalChatEmitUsers(userIds, ev, { message: ins.row })
  }

  return { ok: true, data: { message: ins.row } }
}

/**
 * @param {import('socket.io').Server|null|undefined} io
 * @param {number} companyId
 * @param {number} conversationId
 * @param {number} currentUserId
 * @param {object} body
 */
async function markConversationRead(io, companyId, conversationId, currentUserId, body) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(currentUserId)
  const cid = Number(conversationId)
  if (!Number.isFinite(uid) || !Number.isFinite(cid)) {
    return { ok: false, error: 'Parâmetros inválidos', status: 400 }
  }

  const part = await repo.isUserParticipant(cid, companyId, uid)
  if (!part.ok) return { ok: false, error: part.error, status: 500 }
  if (!part.isParticipant) {
    return { ok: false, error: 'Acesso negado à conversa', status: 403 }
  }

  let lastReadId = parseOptionalLastReadMessageId(body?.last_read_message_id)
  if (lastReadId != null) {
    const bel = await repo.messageBelongsToConversation(lastReadId, cid, companyId)
    if (!bel.ok) return { ok: false, error: bel.error, status: 500 }
    if (!bel.okRow) {
      return { ok: false, error: 'last_read_message_id inválido para esta conversa', status: 400 }
    }
  } else {
    const max = await repo.getLatestMessageId(cid, companyId)
    if (!max.ok) return { ok: false, error: max.error, status: 500 }
    lastReadId = max.id
  }

  const last_read_at = new Date().toISOString()
  const up = await repo.upsertReadState({
    conversation_id: cid,
    user_id: uid,
    last_read_message_id: lastReadId,
    last_read_at,
    updated_at: last_read_at,
  })
  if (!up.ok) {
    return { ok: false, error: up.error, status: 500 }
  }

  const participants = await repo.listParticipants(cid, companyId)
  const userIds = participants.ok ? participants.rows.map((p) => p.user_id) : []

  if (io && userIds.length) {
    const ev = internalChatSocket.INTERNAL_CHAT_EVENTS.CONVERSATION_READ
    io.internalChatEmitUsers(userIds, ev, {
      conversation_id: cid,
      reader_user_id: uid,
      last_read_message_id: lastReadId,
      last_read_at,
    })
  }

  return { ok: true, data: { read: up.row } }
}

module.exports = {
  createOrGetConversation,
  listEmployees,
  listConversations,
  listMessages,
  sendMessage,
  markConversationRead,
}
