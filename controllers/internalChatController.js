const internalChatService = require('../services/internalChatService')
const { parseRequiredUserId, parseConversationIdParam } = require('../validators/internalChatValidators')
const { getPublicApiBase } = require('../helpers/internalChatMediaUrl')

function getIo(req) {
  try {
    return req.app.get('io') || null
  } catch (_) {
    return null
  }
}

/** GET /internal-chat/client-contacts?q=&limit=&offset= — clientes da empresa (CRM) para picker de contato */
exports.listClientContacts = async (req, res) => {
  const { company_id } = req.user
  const result = await internalChatService.listClientContacts(company_id, req.query || {})
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.json(result.data)
}

/** GET /internal-chat/employees */
exports.listEmployees = async (req, res) => {
  const { id: userId, company_id } = req.user
  const result = await internalChatService.listEmployees(company_id, userId)
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.json(result.data)
}

/** POST /internal-chat/conversations */
exports.createOrGetConversation = async (req, res) => {
  const { id: userId, company_id } = req.user
  const parsed = parseRequiredUserId(req.body?.target_user_id, 'target_user_id')
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }
  const io = getIo(req)
  const result = await internalChatService.createOrGetConversation(io, company_id, userId, parsed.id)
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  const status = result.created ? 201 : 200
  return res.status(status).json({ ...result.data, created: result.created })
}

/** GET /internal-chat/conversations */
exports.listConversations = async (req, res) => {
  const { id: userId, company_id } = req.user
  const result = await internalChatService.listConversations(company_id, userId)
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.json(result.data)
}

/** GET /internal-chat/conversations/:id/messages */
exports.listMessages = async (req, res) => {
  const { id: userId, company_id } = req.user
  const cid = parseConversationIdParam(req.params.id)
  if (!cid.ok) {
    return res.status(400).json({ error: cid.error })
  }
  const result = await internalChatService.listMessages(company_id, cid.id, userId, req.query)
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.json(result.data)
}

/** POST /internal-chat/conversations/:id/messages/media — multipart (arquivo); opcional caption / message_type=sticker */
exports.sendMediaMessage = async (req, res) => {
  const { id: userId, company_id } = req.user
  const cid = parseConversationIdParam(req.params.id)
  if (!cid.ok) {
    return res.status(400).json({ error: cid.error })
  }
  const io = getIo(req)
  const result = await internalChatService.sendMediaMessage(
    io,
    company_id,
    cid.id,
    userId,
    req.file,
    req.body || {}
  )
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.status(201).json(result.data)
}

/** POST /internal-chat/conversations/:id/messages — JSON: texto, localização, contato ou mídia já em /uploads/ */
exports.sendMessage = async (req, res) => {
  const { id: userId, company_id } = req.user
  const cid = parseConversationIdParam(req.params.id)
  if (!cid.ok) {
    return res.status(400).json({ error: cid.error })
  }
  const io = getIo(req)
  const result = await internalChatService.sendMessage(io, company_id, cid.id, userId, req.body || {})
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.status(201).json(result.data)
}

/** POST /internal-chat/conversations/:id/read */
exports.markRead = async (req, res) => {
  const { id: userId, company_id } = req.user
  const cid = parseConversationIdParam(req.params.id)
  if (!cid.ok) {
    return res.status(400).json({ error: cid.error })
  }
  const io = getIo(req)
  const result = await internalChatService.markConversationRead(io, company_id, cid.id, userId, req.body || {})
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.json(result.data)
}

/** POST /internal-chat/forward-atendimento-message — encaminhar mensagem(ns) do atendimento para o chat interno (`mensagem_id` ou `mensagem_ids`) */
exports.forwardAtendimentoMessage = async (req, res) => {
  const { id: userId, company_id } = req.user
  const io = getIo(req)
  const result = await internalChatService.forwardAtendimentoMessage(io, company_id, userId, req.body || {})
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error })
  }
  return res.status(201).json(result.data)
}

/** GET /internal-chat/status */
exports.status = (req, res) => {
  const base = getPublicApiBase()
  return res.json({
    module: 'internal-chat',
    ok: true,
    company_id: req.user?.company_id ?? null,
    /** Base usada para absolutizar /uploads/ em mídias (APP_URL/BASE_URL). */
    public_media_base_url: base || null,
  })
}
