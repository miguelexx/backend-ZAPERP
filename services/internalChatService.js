/**
 * Regras de negócio — chat interno (isolado do WhatsApp).
 */

const supabase = require('../config/supabase')
const repo = require('../repositories/internalChatRepository')
const {
  assertPositiveCompanyId,
  validatePairRequest,
  validateMessageContent,
  validateOptionalCaption,
  validateMessageType,
  validateLocationMessage,
  validateContactMessage,
  validateInternalMediaUrl,
  parseMessagesPagination,
  parseOptionalLastReadMessageId,
  parseRequiredUserId,
} = require('../validators/internalChatValidators')
const { MEDIA_MESSAGE_TYPES, MESSAGE_TYPE, MAX_CONTENT_LENGTH } = require('../repositories/internalChatConstants')
const presence = require('../socket/internalChatPresence')
const internalChatSocket = require('../socket/internalChatSocket')
const { enrichInternalChatMessageRow, resolvePublicMediaUrl, getPublicApiBase } = require('../helpers/internalChatMediaUrl')

const FORWARD_ATEND_PREFIX = '[Encaminhado do atendimento]'

/**
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function toInternalUploadsPath(url) {
  if (url == null) return null
  const s = String(url).trim()
  if (s.startsWith('/uploads/')) return s
  const base = getPublicApiBase()
  if (!base) return null
  if (s.startsWith(`${base}/uploads/`)) return s.slice(base.length)
  if (s.startsWith(base)) {
    const tail = s.slice(base.length)
    if (tail.startsWith('/uploads/')) return tail
  }
  return null
}

/**
 * @param {string} tipoOriginal
 * @param {boolean} hasUploadPath
 * @returns {string|null}
 */
function mapWhatsappTipoToInternalMedia(tipoOriginal, hasUploadPath) {
  if (!hasUploadPath) return null
  const t = String(tipoOriginal || '').toLowerCase()
  if (t === 'imagem') return MESSAGE_TYPE.IMAGE
  if (t === 'video') return MESSAGE_TYPE.VIDEO
  if (t === 'audio' || t === 'voice') return MESSAGE_TYPE.AUDIO
  if (t === 'arquivo') return MESSAGE_TYPE.DOCUMENT
  if (t === 'sticker') return MESSAGE_TYPE.STICKER
  return null
}

/**
 * Corpo insertMessage (sem conversation_id / company_id / sender_user_id).
 * @param {object} m — linha mensagens
 * @returns {{ ok: true, insertPayload: object } | { ok: false, error: string, status: number }}
 */
function buildForwardInsertFromMensagem(m) {
  const tipoOriginal = String(m.tipo || 'texto').toLowerCase()
  const mediaPath = toInternalUploadsPath(m.url)
  const internalMediaType = mapWhatsappTipoToInternalMedia(tipoOriginal, !!mediaPath)

  const baseFields = () => ({
    message_type: MESSAGE_TYPE.TEXT,
    content: '',
    media_url: null,
    file_name: null,
    mime_type: null,
    file_size: null,
    payload: null,
  })

  if (tipoOriginal === 'contact') {
    const meta = m.contact_meta && typeof m.contact_meta === 'object' ? m.contact_meta : {}
    const name = String(meta.nome ?? meta.name ?? m.texto ?? 'Contato').trim() || 'Contato'
    const phoneRaw = String(meta.telefone ?? meta.phone ?? '').trim()
    const phoneDigits = phoneRaw.replace(/\D/g, '')
    const phoneForCard = (phoneDigits || phoneRaw || '').trim()
    if (phoneForCard) {
      const ct = validateContactMessage({ contact: { name, phone: phoneForCard } })
      if (ct.ok) {
        return {
          ok: true,
          insertPayload: {
            ...baseFields(),
            message_type: MESSAGE_TYPE.CONTACT,
            content: ct.content,
            payload: ct.payload,
          },
        }
      }
    }
    const line = `${FORWARD_ATEND_PREFIX}\n${name}${phoneRaw ? ` — ${phoneRaw}` : ''}`.slice(0, MAX_CONTENT_LENGTH)
    const mv = validateMessageContent(line)
    if (!mv.ok) {
      return { ok: false, error: mv.error, status: 400 }
    }
    return {
      ok: true,
      insertPayload: { ...baseFields(), message_type: MESSAGE_TYPE.TEXT, content: mv.content },
    }
  }

  if (tipoOriginal === 'location' && m.location_meta && typeof m.location_meta === 'object') {
    const lm = m.location_meta
    const addressParts = [lm.nome, lm.endereco].filter((x) => x != null && String(x).trim())
    const loc = validateLocationMessage({
      latitude: lm.latitude,
      longitude: lm.longitude,
      address: addressParts.length ? addressParts.join(' — ') : undefined,
      content: '',
    })
    if (!loc.ok) {
      const line = `${FORWARD_ATEND_PREFIX}\n${String(m.texto || 'Localização').trim()}`.slice(0, MAX_CONTENT_LENGTH)
      const mv = validateMessageContent(line)
      if (!mv.ok) return { ok: false, error: mv.error, status: 400 }
      return {
        ok: true,
        insertPayload: { ...baseFields(), message_type: MESSAGE_TYPE.TEXT, content: mv.content },
      }
    }
    return {
      ok: true,
      insertPayload: {
        ...baseFields(),
        message_type: MESSAGE_TYPE.LOCATION,
        content: loc.content,
        payload: loc.payload,
      },
    }
  }

  if (internalMediaType && MEDIA_MESSAGE_TYPES.has(internalMediaType)) {
    const mu = validateInternalMediaUrl(mediaPath)
    if (mu.ok) {
      const rawCaption = String(m.texto || '').trim()
      const capText =
        rawCaption && !rawCaption.startsWith('(')
          ? `${FORWARD_ATEND_PREFIX}\n${rawCaption}`.slice(0, MAX_CONTENT_LENGTH)
          : FORWARD_ATEND_PREFIX
      const cap = validateOptionalCaption(capText)
      if (!cap.ok) return { ok: false, error: cap.error, status: 400 }
      let fileName = m.nome_arquivo != null ? String(m.nome_arquivo).replace(/\u0000/g, '').slice(0, 255) : null
      if (!fileName && internalMediaType === MESSAGE_TYPE.DOCUMENT) fileName = 'arquivo'
      return {
        ok: true,
        insertPayload: {
          ...baseFields(),
          message_type: internalMediaType,
          media_url: mu.media_url,
          content: cap.content,
          file_name: fileName,
          mime_type: null,
        },
      }
    }
  }

  const textoOriginal = (m.texto && String(m.texto).trim()) || '(sem texto)'
  const prefixed = `${FORWARD_ATEND_PREFIX}\n${textoOriginal}`.slice(0, MAX_CONTENT_LENGTH)
  const mv = validateMessageContent(prefixed)
  if (!mv.ok) return { ok: false, error: mv.error, status: 400 }
  return {
    ok: true,
    insertPayload: { ...baseFields(), message_type: MESSAGE_TYPE.TEXT, content: mv.content },
  }
}

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
          message_type: r.last_message_type || MESSAGE_TYPE.TEXT,
          content: r.last_message_content,
          media_url: resolvePublicMediaUrl(r.last_message_media_url ?? null),
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

  const messages = (page.messages || []).map((m) => ({
    ...enrichInternalChatMessageRow(m),
    is_mine: Number(m.sender_user_id) === uid,
  }))

  return {
    ok: true,
    data: {
      messages,
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
/**
 * @param {import('socket.io').Server|null|undefined} io
 * @param {number} companyId
 * @param {number} cid
 * @param {number} uid
 * @param {object} insertPayload
 */
async function insertInternalMessageAndEmit(io, companyId, cid, uid, insertPayload) {
  const ins = await repo.insertMessage(insertPayload)
  if (!ins.ok) {
    return { ok: false, error: ins.error, status: 500 }
  }

  const rowPublic = enrichInternalChatMessageRow(ins.row)

  const participants = await repo.listParticipants(cid, companyId)
  const userIds = participants.ok ? participants.rows.map((p) => p.user_id) : []
  const senderId = Number(ins.row.sender_user_id)

  if (io && userIds.length) {
    const ev = internalChatSocket.INTERNAL_CHAT_EVENTS.MESSAGE_CREATED
    for (const rid of userIds) {
      const recipientId = Number(rid)
      if (!Number.isFinite(recipientId)) continue
      io.internalChatEmitUser(recipientId, ev, {
        message: {
          ...rowPublic,
          is_mine: senderId === recipientId,
        },
      })
    }
  }

  const outMsg = {
    ...rowPublic,
    is_mine: senderId === uid,
  }

  return { ok: true, data: { message: outMsg } }
}

function inferMessageTypeFromMime(mimetype, bodyMessageType) {
  const wanted = String(bodyMessageType || '').trim().toLowerCase()
  if (wanted === MESSAGE_TYPE.STICKER) return MESSAGE_TYPE.STICKER
  if (wanted === MESSAGE_TYPE.IMAGE) return MESSAGE_TYPE.IMAGE
  if (wanted === MESSAGE_TYPE.AUDIO) return MESSAGE_TYPE.AUDIO
  if (wanted === MESSAGE_TYPE.VIDEO) return MESSAGE_TYPE.VIDEO
  if (wanted === MESSAGE_TYPE.DOCUMENT) return MESSAGE_TYPE.DOCUMENT

  const base = String(mimetype || '').split(';')[0].trim().toLowerCase()
  if (base.startsWith('image/')) return MESSAGE_TYPE.IMAGE
  if (base.startsWith('audio/')) return MESSAGE_TYPE.AUDIO
  if (base.startsWith('video/')) return MESSAGE_TYPE.VIDEO
  return MESSAGE_TYPE.DOCUMENT
}

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

  const t = tv.message_type

  /** @type {object} */
  const insertPayload = {
    conversation_id: cid,
    company_id: companyId,
    sender_user_id: uid,
    message_type: t,
    content: '',
    media_url: null,
    file_name: null,
    mime_type: null,
    file_size: null,
    payload: null,
  }

  if (t === MESSAGE_TYPE.TEXT) {
    const mv = validateMessageContent(body?.content)
    if (!mv.ok) return { ok: false, error: mv.error, status: 400 }
    insertPayload.content = mv.content
  } else if (t === MESSAGE_TYPE.LOCATION) {
    const loc = validateLocationMessage(body || {})
    if (!loc.ok) return { ok: false, error: loc.error, status: 400 }
    insertPayload.payload = loc.payload
    insertPayload.content = loc.content
  } else if (t === MESSAGE_TYPE.CONTACT) {
    const ct = validateContactMessage(body || {})
    if (!ct.ok) return { ok: false, error: ct.error, status: 400 }
    insertPayload.payload = ct.payload
    insertPayload.content = ct.content
  } else if (MEDIA_MESSAGE_TYPES.has(t)) {
    const mu = validateInternalMediaUrl(body?.media_url)
    if (!mu.ok) {
      return {
        ok: false,
        error: `${mu.error} Envie o arquivo em POST /conversations/:id/messages/media ou use uma media_url prévia do próprio sistema (/uploads/...).`,
        status: 400,
      }
    }
    const cap = validateOptionalCaption(body?.content ?? body?.caption)
    if (!cap.ok) return { ok: false, error: cap.error, status: 400 }
    insertPayload.media_url = mu.media_url
    insertPayload.content = cap.content
    if (body?.file_name != null) {
      insertPayload.file_name = String(body.file_name).replace(/\u0000/g, '').slice(0, 255)
    }
    if (body?.mime_type != null) {
      insertPayload.mime_type = String(body.mime_type).replace(/\u0000/g, '').slice(0, 200)
    }
    const fsz = Number(body?.file_size)
    if (Number.isFinite(fsz) && fsz >= 0) insertPayload.file_size = fsz
  } else {
    return { ok: false, error: 'Tipo de mensagem não suportado', status: 400 }
  }

  return insertInternalMessageAndEmit(io, companyId, cid, uid, insertPayload)
}

/**
 * Upload multipart (multer). Não chama WhatsApp nem webhooks.
 * @param {import('socket.io').Server|null|undefined} io
 * @param {object|null} file
 * @param {object} body
 */
async function sendMediaMessage(io, companyId, conversationId, currentUserId, file, body) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(currentUserId)
  const cid = Number(conversationId)
  if (!Number.isFinite(uid) || !Number.isFinite(cid)) {
    return { ok: false, error: 'Parâmetros inválidos', status: 400 }
  }

  if (!file || !file.filename) {
    return { ok: false, error: 'Arquivo obrigatório (multipart)', status: 400 }
  }

  const part = await repo.isUserParticipant(cid, companyId, uid)
  if (!part.ok) return { ok: false, error: part.error, status: 500 }
  if (!part.isParticipant) {
    return { ok: false, error: 'Acesso negado à conversa', status: 403 }
  }

  const message_type = inferMessageTypeFromMime(file.mimetype, body?.message_type)
  if (!MEDIA_MESSAGE_TYPES.has(message_type)) {
    return { ok: false, error: 'Tipo de mídia não suportado', status: 400 }
  }

  const cap = validateOptionalCaption(body?.caption ?? body?.content)
  if (!cap.ok) return { ok: false, error: cap.error, status: 400 }

  const relativeUrl = `/uploads/${file.filename}`
  const vurl = validateInternalMediaUrl(relativeUrl)
  if (!vurl.ok) return { ok: false, error: vurl.error, status: 500 }

  const insertPayload = {
    conversation_id: cid,
    company_id: companyId,
    sender_user_id: uid,
    message_type,
    content: cap.content || '',
    media_url: vurl.media_url,
    file_name: String(file.originalname || file.filename || 'arquivo').replace(/\u0000/g, '').slice(0, 255),
    mime_type: String(file.mimetype || '').split(';')[0].trim().slice(0, 200),
    file_size: Number(file.size) >= 0 ? Number(file.size) : null,
    payload: null,
  }

  return insertInternalMessageAndEmit(io, companyId, cid, uid, insertPayload)
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

/**
 * Clientes (CRM) da empresa — para o modal de compartilhar contato no chat interno.
 * @param {number} companyId
 * @param {Record<string, unknown>} query
 */
/**
 * Replica uma mensagem do atendimento (WhatsApp) no chat interno com outro colaborador.
 * @param {import('socket.io').Server|null|undefined} io
 * @param {number} companyId
 * @param {number} userId
 * @param {{ mensagem_id?: unknown, conversa_origem_id?: unknown, target_user_id?: unknown }} body
 */
async function forwardAtendimentoMessage(io, companyId, userId, body) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const uid = Number(userId)
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, error: 'Usuário autenticado inválido', status: 401 }
  }

  const midParsed = parseRequiredUserId(body?.mensagem_id, 'mensagem_id')
  if (!midParsed.ok) return { ok: false, error: midParsed.error, status: 400 }
  const convParsed = parseRequiredUserId(body?.conversa_origem_id, 'conversa_origem_id')
  if (!convParsed.ok) return { ok: false, error: convParsed.error, status: 400 }
  const tgtParsed = parseRequiredUserId(body?.target_user_id, 'target_user_id')
  if (!tgtParsed.ok) return { ok: false, error: tgtParsed.error, status: 400 }

  const mid = midParsed.id
  const convOrig = convParsed.id
  const tgt = tgtParsed.id

  const { data: m, error: errM } = await supabase
    .from('mensagens')
    .select('id, texto, tipo, url, nome_arquivo, contact_meta, location_meta, conversa_id, company_id')
    .eq('company_id', Number(companyId))
    .eq('id', mid)
    .maybeSingle()

  if (errM) return { ok: false, error: errM.message, status: 500 }
  if (!m) return { ok: false, error: 'Mensagem não encontrada', status: 404 }
  if (Number(m.conversa_id) !== convOrig) {
    return { ok: false, error: 'Mensagem não pertence à conversa de origem', status: 400 }
  }

  const convRes = await createOrGetConversation(io, companyId, uid, tgt)
  if (!convRes.ok) return convRes

  const internalCid = Number(convRes.data.conversation.id)
  const built = buildForwardInsertFromMensagem(m)
  if (!built.ok) return built

  const insertPayload = {
    ...built.insertPayload,
    conversation_id: internalCid,
    company_id: Number(companyId),
    sender_user_id: uid,
  }

  return insertInternalMessageAndEmit(io, companyId, internalCid, uid, insertPayload)
}

async function listClientContacts(companyId, query) {
  const c = assertPositiveCompanyId(companyId)
  if (!c.ok) return c

  const res = await repo.listClientContactsForPicker(companyId, {
    q: query?.q,
    limit: query?.limit,
    offset: query?.offset,
  })
  if (!res.ok) return { ok: false, error: res.error, status: 500 }

  const contacts = (res.rows || []).map((r) => {
    const nome = r.nome != null ? String(r.nome).trim() : ''
    const push = r.pushname != null ? String(r.pushname).trim() : ''
    return {
      id: Number(r.id),
      name: nome || push || null,
      pushname: push || null,
      phone: r.telefone != null ? String(r.telefone).trim() : null,
      avatar: r.foto_perfil != null ? String(r.foto_perfil).trim() : null,
    }
  })

  return {
    ok: true,
    data: {
      contacts,
      total: res.total,
    },
  }
}

module.exports = {
  createOrGetConversation,
  listEmployees,
  listClientContacts,
  listConversations,
  listMessages,
  sendMessage,
  sendMediaMessage,
  markConversationRead,
  forwardAtendimentoMessage,
}
