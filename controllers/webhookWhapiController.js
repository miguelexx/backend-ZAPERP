/**
 * Webhook Whapi Cloud (2º provider). Normaliza eventos Whapi para o MESMO formato interno
 * "zapi-like" consumido pelo pipeline ATIVO (webhookZapiController — nome legado) e DELEGA
 * a receberZapi / statusZapi. NÃO importa nada do webhookUltramsgController.
 *
 * Whapi envia arrays por POST: `messages` (inbound e from_me) e `statuses` (ACK).
 * Cada item é normalizado e despachado ao handler certo; respondemos UMA vez ao final.
 *
 * Fase B: texto + ACK + mídia por `link` + reação `action`.
 * Contrato Whapi CONFIRMADO via MCP health/schema + OpenAPI (2026-09-04). Ver doc 25 §3.
 */

const { normalizePhoneBR } = require('../helpers/phoneHelper')
const webhookCoreController = require('./webhookZapiController')
const supabase = require('../config/supabase')
const {
  buildEditadaDbUpdates,
  isMissingEditadaColumnError,
  buildMensagemEditadaSocketPayload,
} = require('../helpers/mensagemEditHelper')

function isWhapiEditedMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.edited === true || m.is_edited === true || m.isEdit === true) return true
  return String(m.action?.type || '').toLowerCase() === 'edit'
}

function extractWhapiEditedTexto(m) {
  if (!m || typeof m !== 'object') return ''
  const type = String(m.type ?? 'text').toLowerCase()
  const typed = m[type]
  return String(
    (m.text && (m.text.body ?? m.text))
    || m.body
    || m.caption
    || (typed && typeof typed === 'object' ? typed.caption : '')
    || ''
  )
}

async function applyWhapiEditedMessage(ctxSrc, m, io) {
  const id = String(m?.id || '').trim()
  if (!id || ctxSrc?.company_id == null) return false
  const texto = extractWhapiEditedTexto(m)
  const updates = buildEditadaDbUpdates(texto)
  const runUpdate = async (payload, select) => {
    let query = supabase
      .from('mensagens')
      .update(payload)
      .eq('company_id', ctxSrc.company_id)
      .eq('whatsapp_id', id)
    if (ctxSrc.whatsapp_instance_id) {
      query = query.eq('whatsapp_instance_id', ctxSrc.whatsapp_instance_id)
    }
    return query.select(select).maybeSingle()
  }
  let { data, error } = await runUpdate(updates, 'id, conversa_id, texto, tipo, editada_em')
  if (error && isMissingEditadaColumnError(error)) {
    ;({ data, error } = await runUpdate({ texto }, 'id, conversa_id, texto, tipo'))
  }
  if (error || !data?.id) return false
  if (io) {
    io.to(`conversa_${data.conversa_id}`).emit(
      io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
      buildMensagemEditadaSocketPayload({
        id: data.id,
        conversa_id: data.conversa_id,
        company_id: ctxSrc.company_id,
        texto,
        editada_em: data.editada_em || updates.editada_em,
        tipo: data.tipo || null,
      })
    )
  }
  return true
}

/** Extrai dígitos de um JID (5534999@s.whatsapp.net → 5534999; 120363@g.us → 120363).
 * @lid NÃO é telefone — devolve vazio para o caller usar a chave lid:… */
function isLidJid(jid) {
  const s = String(jid || '').trim().toLowerCase()
  return s.endsWith('@lid') || s.endsWith('@broadcast')
}

function jidToDigits(jid) {
  if (!jid || typeof jid !== 'string') return ''
  if (isLidJid(jid)) return ''
  return String(jid).replace(/@[^@]+$/, '').replace(/\D/g, '')
}

function isGroupJid(v) {
  return typeof v === 'string' && v.trim().toLowerCase().endsWith('@g.us')
}

/** Whapi ack/status → status interno (mesma escala do UltraMSG).
 * CONFIRMADO docs: status string failed|pending|sent|delivered|read|played|deleted
 * e `code` numérico (exemplo oficial code 4 = read). */
function mapWhapiAckToStatus(ack, code) {
  const n = code == null || code === '' ? NaN : Number(code)
  if (Number.isFinite(n)) {
    if (n === 0) return 'erro'
    if (n === 1) return 'pending'
    if (n === 2) return 'sent'
    if (n === 3) return 'delivered'
    if (n === 4) return 'read'
    if (n === 5) return 'played'
    if (n === 6) return 'erro'
  }
  const s = String(ack ?? '').toLowerCase()
  if (s === 'failed' || s === 'error' || s === 'deleted') return 'erro'
  if (s === 'sent' || s === 'server' || s === '1') return 'sent'
  if (s === 'delivered' || s === 'received' || s === 'device' || s === '2') return 'delivered'
  if (s === 'read' || s === 'seen' || s === '3') return 'read'
  if (s === 'played' || s === '4') return 'played'
  if (s === 'pending' || s === '0') return 'pending'
  return s || 'pending'
}

/** URL de mídia de um sub-objeto Whapi ({ link } | string). */
function mediaLink(obj) {
  if (!obj) return null
  if (typeof obj === 'string') return obj.trim().startsWith('http') ? obj.trim() : null
  if (typeof obj === 'object') {
    const v = obj.link ?? obj.url ?? obj.file
    return typeof v === 'string' && v.trim().startsWith('http') ? v.trim() : null
  }
  return null
}

/**
 * Converte um item de `messages[]` do Whapi para o formato interno esperado por receberZapi.
 * @param {object} m item de messages[]
 * @param {object} ctx { channelId, connectedPhone }
 */
/**
 * Extrai a resposta de uma mensagem interativa inbound (toque em botão / item de lista).
 * Whapi entrega em `m.reply` (buttons_reply|list_reply) ou `m.interactive` (button_reply|list_reply).
 * Retorna { id, title, description } ou null. CONFIRMAR shape exato em homologação live (doc 25).
 */
function extractInteractiveReply(m) {
  if (!m || typeof m !== 'object') return null
  const src = m.reply || m.interactive || null
  if (!src || typeof src !== 'object') return null
  const r = src.buttons_reply || src.button_reply || src.list_reply || src.selected_button || src
  const id = r?.id ?? r?.selected_id ?? r?.selectedRowId ?? src.id ?? null
  const title = r?.title ?? r?.selected_display_text ?? r?.text ?? null
  const description = r?.description ?? null
  if (id == null && title == null) return null
  return {
    id: id != null ? String(id) : null,
    title: title != null ? String(title) : null,
    description: description != null ? String(description) : null,
  }
}

/**
 * Extrai o voto de uma enquete inbound. Whapi (INFERÊNCIA — confirmar live): `m.action`
 * (type 'vote') com `votes`/`selected_options` e `target` = id da mensagem da enquete.
 * As opções podem vir como texto (ideal) ou hash/índice. Retorna { target, options: string[] }.
 */
function extractPollVote(m) {
  if (!m || typeof m !== 'object') return { target: null, options: [] }
  const a = m.action || m.poll || m
  const target = a.target ?? a.poll_id ?? a.message_id ?? m.context?.quoted_id ?? null
  let raw = a.votes ?? a.selected_options ?? a.options ?? m.votes ?? []
  if (!Array.isArray(raw)) raw = raw != null ? [raw] : []
  const options = raw
    .map((v) => {
      if (v == null) return ''
      if (typeof v === 'string') return v.trim()
      if (typeof v === 'object') return String(v.name ?? v.title ?? v.text ?? v.option ?? '').trim()
      return String(v).trim()
    })
    .filter(Boolean)
  return { target: target != null ? String(target) : null, options }
}

function normalizeWhapiMessageToInternal(m, ctx = {}) {
  if (!m || typeof m !== 'object') return null
  const channelId = ctx.channelId
  const fromMe = Boolean(m.from_me ?? m.fromMe)
  const chatJid = String(m.chat_id ?? m.chatId ?? m.chat?.id ?? '').trim()
  const fromJid = String(m.from ?? '').trim()
  const isGroup = isGroupJid(chatJid) || isGroupJid(fromJid)
  const type = String(m.type ?? 'text').toLowerCase()
  const actionType = String(m.action?.type || '').toLowerCase()
  const isReaction = type === 'reaction' || (type === 'action' && actionType === 'reaction')
  // Voto em enquete: type 'action' + action.type 'vote' (ou type poll_vote/vote).
  // Vira inbound de texto (opção escolhida) p/ a URA tratar como resposta. CONFIRMAR shape live (doc 25 §29).
  const isPollVote = (type === 'action' && actionType === 'vote') || type === 'poll_vote' || type === 'vote'
  // Outros `action` (ex. media_notify) não são mensagem de atendimento.
  if (type === 'action' && !isReaction && !isPollVote) return null
  if (type === 'deleted' || type === 'revoke' || type === 'revoked' || m.deleted === true) return null

  const isEdit = Boolean(m.edited || m.is_edited || m.isEdit || String(m.action?.type || '').toLowerCase() === 'edit')

  let phone = ''
  let remoteJid = ''
  let participantPhone = ''
  if (isGroup) {
    remoteJid = isGroupJid(chatJid) ? chatJid : (isGroupJid(fromJid) ? fromJid : chatJid)
    phone = remoteJid
    const fromCandidate = [m.from, m.author, m.participant]
      .map((v) => String(v || '').trim())
      .find((s) => s && !isGroupJid(s))
    participantPhone = jidToDigits(fromCandidate || '')
  } else {
    remoteJid = chatJid || fromJid
    const digits = jidToDigits(remoteJid) || jidToDigits(chatJid) || jidToDigits(fromJid)
    if (digits) {
      phone = normalizePhoneBR(digits) || digits
    } else {
      const lidJid = [chatJid, fromJid, remoteJid].find(isLidJid) || ''
      // Preserva o JID @lid para o pipeline (resolveConversationKeyFromZapi → lid:…).
      phone = lidJid || remoteJid
    }
  }

  const messageId = (m.id && String(m.id).trim()) ? String(m.id).trim() : null

  // Resposta interativa (toque em botão/lista): o título vira o texto do inbound para a URA
  // tratar como uma resposta digitada; o id fica disponível p/ casamento exato futuro.
  const interactiveReply = (type === 'reply' || type === 'interactive')
    ? extractInteractiveReply(m)
    : null
  const pollVote = isPollVote ? extractPollVote(m) : null

  // Texto: { text: { body } }; link_preview; resposta interativa; voto de enquete; caption em mídia.
  const textBody = String(
    (m.text && (m.text.body ?? m.text))
    || (type === 'link_preview' && (m.link_preview?.body || m.link_preview?.title))
    || (interactiveReply && (interactiveReply.title || interactiveReply.id))
    || (pollVote && (pollVote.options.join(', ') || '(voto na enquete)'))
    || m.body
    || m.caption
    || m[type]?.caption
    || ''
  )

  // Mídia por tipo (Fase B faz o download; aqui já mapeamos a URL para não perder o link).
  const imageUrl = type === 'image' ? mediaLink(m.image) : null
  const audioUrl = (type === 'audio' || type === 'voice' || type === 'ptt') ? mediaLink(m.audio ?? m.voice) : null
  const videoUrl = type === 'video' ? mediaLink(m.video) : null
  const documentUrl = (type === 'document' || type === 'file') ? mediaLink(m.document ?? m.file) : null
  const stickerUrl = type === 'sticker' ? mediaLink(m.sticker) : null
  const captionText = m[type]?.caption ?? m.caption ?? null
  const fileName = m.document?.file_name ?? m.document?.filename ?? m.file?.filename ?? null

  // Reação: emoji + alvo.
  const reactionPayload = isReaction
    ? {
        value: m.action?.emoji ?? m.reaction?.emoji ?? m.emoji ?? '',
        emoji: m.action?.emoji ?? m.reaction?.emoji ?? m.emoji ?? '',
        time: m.timestamp ?? null,
        messageId: m.action?.target ?? m.reaction?.message_id ?? m.reaction?.target ?? m.context?.quoted_id ?? null,
      }
    : null

  // Citação / reply.
  const quotedId = m.context?.quoted_id ?? m.context?.quotedId ?? m.quoted_id ?? null
  const quotedMsg = m.context?.quoted_content ?? m.quotedMsg ?? (quotedId ? { id: quotedId } : null)

  // Localização.
  const locSrc = (type === 'location' && m.location)
    || (type === 'live_location' && (m.live_location || m.location))
    || null
  const loc = (locSrc && typeof locSrc === 'object') ? locSrc : null
  const locationPayload = loc ? {
    latitude: Number(loc.latitude ?? loc.lat) || 0,
    longitude: Number(loc.longitude ?? loc.lng) || 0,
    address: String(loc.address ?? loc.caption ?? '').trim(),
    name: String(loc.name ?? '').trim(),
  } : undefined

  const contactPayload = (type === 'contact' && m.contact && typeof m.contact === 'object')
    ? {
        displayName: m.contact.name || null,
        formattedName: m.contact.name || null,
        vCard: m.contact.vcard || m.contact.vCard || null,
      }
    : undefined

  const senderNameRaw = fromMe ? null : (m.from_name ?? m.notify ?? m.pushname ?? null)
  const senderName = senderNameRaw ? String(senderNameRaw).trim() : null

  const connectedPhone = ctx.connectedPhone
    ? (normalizePhoneBR(String(ctx.connectedPhone).replace(/\D/g, '')) || String(ctx.connectedPhone).replace(/\D/g, ''))
    : undefined

  // type interno: ptt→audio; reaction; senão o tipo Whapi (text vira 'chat' p/ compat com o pipeline).
  const internalType = isReaction ? 'reaction'
    : (type === 'ptt' || type === 'voice') ? 'audio'
    : (type === 'text' || type === 'link_preview') ? 'chat'
    : (type === 'reply' || type === 'interactive') ? 'chat'
    : isPollVote ? 'chat'
    : (type === 'live_location') ? 'location'
    : type

  return {
    instanceId: channelId,
    instance_id: channelId,
    event_type: 'message_received',
    fromMe,
    phone,
    remoteJid,
    isGroup,
    messageId,
    zaapId: messageId,
    id: messageId,
    body: textBody,
    message: textBody,
    text: { message: textBody },
    type: internalType,
    participantPhone: participantPhone || undefined,
    participant: participantPhone ? `${participantPhone}@c.us` : undefined,
    key: {
      remoteJid: remoteJid || phone,
      fromMe,
      id: messageId,
      participant: isGroup && fromJid ? fromJid : undefined,
    },
    chatId: remoteJid,
    chat: { id: remoteJid, remoteJid },
    timestamp: m.timestamp ? Number(m.timestamp) * 1000 : Date.now(),
    t: m.timestamp,
    ack: 'pending',
    status: 'RECEIVED',
    imageUrl: imageUrl || null,
    audioUrl: audioUrl || null,
    videoUrl: videoUrl || null,
    documentUrl: documentUrl || null,
    stickerUrl: stickerUrl || null,
    fileName: fileName || undefined,
    caption: captionText || undefined,
    interactiveReplyId: interactiveReply?.id || undefined,
    interactiveReplyTitle: interactiveReply?.title || undefined,
    pollVoteTarget: pollVote?.target || undefined,
    pollVoteOptions: pollVote?.options?.length ? pollVote.options : undefined,
    senderName,
    name: senderName,
    notifyName: senderName,
    pushName: senderName,
    connectedPhone,
    ownerPhone: connectedPhone,
    quotedMsg: quotedMsg || undefined,
    referenceMessageId: quotedId || undefined,
    ...(locationPayload ? { location: locationPayload } : {}),
    ...(reactionPayload ? { reaction: reactionPayload } : {}),
    ...(contactPayload ? { contact: contactPayload } : {}),
    isEdit,
  }
}

/** Converte um item de `statuses[]` do Whapi para o formato interno de ACK (statusZapi). */
function normalizeWhapiStatusToInternal(s, ctx = {}) {
  if (!s || typeof s !== 'object') return null
  const msgId = s.id ?? s.message_id ?? s.messageId ?? null
  if (!msgId) return null
  const ids = [String(msgId).trim()]
  return {
    instanceId: ctx.channelId,
    instance_id: ctx.channelId,
    type: 'MessageStatusCallback',
    messageId: msgId,
    zaapId: msgId,
    id: msgId,
    ids,
    ack: s.status ?? s.ack ?? 'pending',
    status: mapWhapiAckToStatus(s.status ?? s.ack, s.code),
    // Whapi não tem referenceId no envio; reconciliação por whatsapp_id (doc 25 §4).
    referenceId: null,
  }
}

/** res "capturado": registra status/body sem tocar o socket real (permite despachar item a item). */
function makeCaptureRes() {
  const captured = { statusCode: 200, body: null }
  const res = {
    statusCode: 200,
    status(code) { captured.statusCode = code; this.statusCode = code; return this },
    json(obj) { captured.body = obj; return this },
    send(obj) { captured.body = obj; return this },
    end() { return this },
    set() { return this },
    setHeader() { return this },
    get() { return undefined },
  }
  return { res, captured }
}

/** Despacha 1 payload normalizado ao handler do pipeline, capturando o status HTTP resultante. */
async function dispatchOne(handler, req, normalizedBody) {
  req.body = normalizedBody
  const { res: captureRes, captured } = makeCaptureRes()
  try {
    await handler(req, captureRes)
  } catch (e) {
    console.error('[WEBHOOK_WHAPI] handler lançou:', e?.message || e)
    return 500
  }
  return captured.statusCode || 200
}

/** Extrai arrays de eventos do corpo Whapi (tolerante a formatos). */
function extractEvents(body) {
  const messages = Array.isArray(body?.messages) ? body.messages
    : (body?.message ? [body.message] : [])
  const statuses = Array.isArray(body?.statuses) ? body.statuses
    : (body?.status && typeof body.status === 'object' ? [body.status] : [])
  const presences = Array.isArray(body?.presences) ? body.presences
    : (body?.presence && typeof body.presence === 'object' ? [body.presence] : [])
  return { messages, statuses, presences }
}

/**
 * Normaliza um item de `presences[]` do Whapi → payload de socket para o header da conversa.
 * Não toca o pipeline de mensagens; presença é efêmera (não persiste). Emite `presenca_contato`.
 */
function normalizeWhapiPresence(p, ctx = {}) {
  if (!p || typeof p !== 'object') return null
  const entry = p.contact_id ?? p.chat_id ?? p.id ?? p.entry_id ?? null
  if (!entry) return null
  const lastSeenRaw = p.last_seen ?? p.lastSeen
  const lastSeen = Number.isFinite(Number(lastSeenRaw)) ? Number(lastSeenRaw) : null
  return {
    channel_id: ctx.channelId,
    chat_id: String(entry),
    telefone: jidToDigits(String(entry)) || null,
    status: p.status ?? p.presence ?? null,
    last_seen: lastSeen,
  }
}

async function handleWebhookWhapi(req, res) {
  try {
    const body = req.body
    if (!body || typeof body !== 'object') {
      req.webhookLogData = { status: 'ignored', error: 'payload_invalido' }
      return res.status(200).json({ ok: true })
    }
    const ctxSrc = req.webhookContext || req.zapiContext
    if (!ctxSrc || ctxSrc.company_id == null) {
      return res.status(200).json({ ok: true })
    }
    const ctx = {
      channelId: ctxSrc.provider_instance_id || ctxSrc.instanceId,
      connectedPhone: ctxSrc.connected_phone || ctxSrc.telefone_conectado || null,
    }

    const { messages, statuses, presences } = extractEvents(body)
    req.webhookLogData = {
      status: 'processed',
      company_id: ctxSrc.company_id,
      instance_id: ctx.channelId,
      event_type: 'whapi',
      counts: { messages: messages.length, statuses: statuses.length, presences: presences.length },
    }

    let anyServerError = false

    for (const m of messages) {
      if (isWhapiEditedMessage(m)) {
        const applied = await applyWhapiEditedMessage(ctxSrc, m, req.app?.get?.('io'))
        if (applied) continue
      }
      const normalized = normalizeWhapiMessageToInternal(m, ctx)
      if (!normalized) continue
      normalized.type = 'ReceivedCallback'
      normalized.instanceId = ctx.channelId
      normalized.instance_id = ctx.channelId
      const code = await dispatchOne(webhookCoreController.receberZapi, req, normalized)
      if (Number(code) >= 500) anyServerError = true
    }

    for (const s of statuses) {
      const normalized = normalizeWhapiStatusToInternal(s, ctx)
      if (!normalized) continue
      // statusZapi sempre responde 200 (mesmo em catch) — não altera anyServerError.
      await dispatchOne(webhookCoreController.statusZapi, req, normalized)
    }

    // Presença do contato — efêmera, só emite socket (nunca persiste, nunca afeta ACK/inbound).
    if (presences.length) {
      const io = req.app?.get?.('io')
      if (io) {
        for (const p of presences) {
          const payload = normalizeWhapiPresence(p, ctx)
          if (!payload) continue
          try {
            io.to(`empresa_${ctxSrc.company_id}`).emit('presenca_contato', { ...payload, company_id: ctxSrc.company_id })
          } catch (e) {
            console.warn('[WEBHOOK_WHAPI] emit presenca_contato falhou:', e?.message || e)
          }
        }
      }
    }

    // Erro interno persistente no inbound → 500 para o provider reentregar (idempotência protege duplicata).
    if (anyServerError) return res.status(500).json({ ok: false, error: 'inbound_processing_error' })
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[handleWebhookWhapi]', e?.message || e)
    req.webhookLogData = { status: 'error', error_message: e?.message || String(e) }
    return res.status(200).json({ ok: true })
  }
}

exports.healthWhapi = (req, res) => res.status(200).json({ ok: true, provider: 'whapi' })

exports.testarWhapi = (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  return res.status(200).json({
    ok: true,
    provider: 'whapi',
    message: 'Configure o webhook do canal no painel Whapi (Settings → Webhooks) apontando para esta URL com header X-Webhook-Token',
    webhook_url: `${base}/webhooks/whapi`,
  })
}

exports.handleWebhookWhapi = handleWebhookWhapi
exports._test = {
  normalizeWhapiMessageToInternal,
  normalizeWhapiStatusToInternal,
  mapWhapiAckToStatus,
  extractEvents,
  jidToDigits,
  isLidJid,
  isWhapiEditedMessage,
  extractWhapiEditedTexto,
  extractInteractiveReply,
  extractPollVote,
  normalizeWhapiPresence,
}
