/**
 * Webhook UltraMsg: recebe eventos e normaliza para formato Z-API.
 * Reutiliza a lógica de processamento do webhookZapiController.
 *
 * Formato UltraMsg (como chega do site):
 * {
 *   event_type: "message_received",
 *   instanceId: "51534",
 *   id, referenceId, hash,
 *   data: {
 *     id, sid, from, to, author, pushname, ack, type, body, media,
 *     fromMe, self, isForwarded, isMentioned, quotedMsg, mentionedIds, time
 *   }
 * }
 * Formato Z-API:   { phone, fromMe, messageId, text/message/body, key, ... }
 */

const { normalizePhoneBR } = require('../helpers/phoneHelper')
const webhookZapiController = require('./webhookZapiController')

/** Extrai dígitos de JID (55349999@c.us → 55349999, 120363@g.us → 120363) */
function jidToDigits(jid) {
  if (!jid || typeof jid !== 'string') return ''
  return String(jid).replace(/@[^@]+$/, '').replace(/\D/g, '')
}

/** Converte payload UltraMsg para formato Z-API compatível. */
function normalizeUltramsgToZapi(body) {
  if (!body || typeof body !== 'object') return body
  const data = body.data || body
  const eventType = String(body.event_type || body.eventType || '').toLowerCase()

  if (eventType === 'message_ack' || eventType === 'webhook_message_ack') {
    const msgId = data.id ?? data.sid ?? data.msgId ?? null
    const ids = msgId ? [String(msgId).trim()] : []
    return {
      instanceId: body.instanceId ?? body.instance_id,
      instance_id: body.instanceId ?? body.instance_id,
      messageId: msgId,
      zaapId: msgId,
      id: msgId,
      ack: data.ack ?? data.status ?? 'pending',
      status: mapUltramsgAckToStatus(data.ack ?? data.status),
      ids
    }
  }

  if (!data || typeof data !== 'object') return body

  const fromMe = Boolean(data.fromMe)
  const fromJid = String(data.from || '').trim()
  const toJid = String(data.to || '').trim()
  const chatIdRaw = String(data.chatId || data.chat?.id || '').trim()
  // UltraMsg: to=grupo para mensagem recebida em grupo; às vezes from=grupo. Aceita chatId também.
  const isGroup = toJid.endsWith('@g.us') || fromJid.endsWith('@g.us') || chatIdRaw.endsWith('@g.us')

  let phone = ''
  let participantPhone = ''
  let remoteJid = ''

  if (isGroup) {
    // Grupo: remoteJid = JID do grupo (to, from ou chatId — quem tem @g.us)
    remoteJid = toJid.endsWith('@g.us') ? toJid : (fromJid.endsWith('@g.us') ? fromJid : (chatIdRaw.endsWith('@g.us') ? chatIdRaw : toJid))
    // UltraMsg usa formato {GroupNumber}-{OwnerNumber}@g.us (ex: 3618420-5534984080098@g.us).
    // Preservar o JID completo — não usar normalizeGroupIdForStorage (perde o hífen e quebra envio).
    phone = remoteJid || (jidToDigits(remoteJid) ? `${jidToDigits(remoteJid)}@g.us` : '')
    participantPhone = jidToDigits(data.author || data.sender || fromJid) || jidToDigits(fromJid) || ''
  } else {
    const contactJid = fromMe ? toJid : fromJid
    phone = normalizePhoneBR(jidToDigits(contactJid)) || jidToDigits(contactJid) || contactJid
    remoteJid = contactJid
  }

  // messageId: UltraMSG usa id (formato "false_xxx@c.us_SID") como identificador canônico - message_ack envia o mesmo id
  const messageId = (data.id && String(data.id).trim()) ? data.id : (data.sid && String(data.sid).trim()) ? data.sid : null
  const bodyText = data.body ?? data.text ?? data.message ?? ''
  const msgType = String(data.type || 'chat').toLowerCase()

  /** Normaliza campo de mídia (string URL ou objeto com url/link/file) para string URL. */
  const toUrl = (v) => {
    if (!v) return null
    if (typeof v === 'string' && v.trim().startsWith('http')) return v.trim()
    if (typeof v === 'object' && v != null) return v.url ?? v.link ?? v.file ?? (v.src && String(v.src).startsWith('http') ? v.src : null) ?? null
    return null
  }

  // data.media: UltraMSG envia string URL ou objeto { url, link, file } para imagem/áudio/vídeo/documento
  // webhook_message_download_media=true: UltraMsg inclui URL da mídia no payload
  const mediaUrl = toUrl(data.media)

  // Áudio: data.audio, data.audioUrl, data.mediaUrl, data.media, data.attachment (UltraMsg pode variar)
  let audioUrl =
    toUrl(data.audio) ??
    toUrl(data.audioUrl) ??
    toUrl(data.attachment) ??
    (msgType === 'audio' || msgType === 'ptt' ? (mediaUrl ?? toUrl(data.mediaUrl) ?? toUrl(data.file)) : null)

  // Mídia por tipo: UltraMSG doc — media (URL) é o campo principal; mediaUrl, document/file, etc. como fallback
  const imageUrl = msgType === 'image' ? (mediaUrl ?? toUrl(data.mediaUrl) ?? toUrl(data.image)) : toUrl(data.image)
  const documentUrl = toUrl(data.documentUrl) ?? toUrl(data.document) ?? toUrl(data.file) ?? (msgType === 'document' || msgType === 'file' ? mediaUrl : null)
  const videoUrl = msgType === 'video' ? (mediaUrl ?? toUrl(data.videoUrl) ?? toUrl(data.video)) : (toUrl(data.videoUrl) ?? toUrl(data.video))
  const stickerUrl = msgType === 'sticker' ? (mediaUrl ?? toUrl(data.stickerUrl) ?? toUrl(data.sticker)) : (toUrl(data.stickerUrl) ?? toUrl(data.sticker))

  // Nome e foto: UltraMsg envia pushname = nome de quem ENVIOU.
  // Quando fromMe=true (message_create), pushname é NOSSO nome — NÃO usar para contato.
  const senderNameRaw = data.pushname ?? data.notify ?? data.senderName ?? data.name ?? data.formattedName ?? data.short ?? data.chatName ?? data.displayName ?? null
  const senderName = fromMe ? null : (senderNameRaw ? String(senderNameRaw).trim() : null)
  // Regra: UltraMsg message_received/message_ack NUNCA traz profile picture no payload.
  // Buscar foto via GET /contacts/image (disparado por syncUltraMsgContact no receberZapi).
  const senderPhoto = null

  // quotedMsg: citação/reply — Ultramsg envia { id, body, from, ... }
  const quotedMsg = data.quotedMsg && typeof data.quotedMsg === 'object' && Object.keys(data.quotedMsg).length > 0 ? data.quotedMsg : null
  const referenceMessageId = quotedMsg ? (quotedMsg.id ?? quotedMsg.stanzaId ?? quotedMsg.messageId ?? null) : null

  // connectedPhone: nosso número (to quando recebemos, from quando enviamos) — necessário para resolveConversationKeyFromZapi
  const connectedPhone = fromMe ? jidToDigits(fromJid) : jidToDigits(toJid)
  const connectedPhoneNorm = connectedPhone ? (normalizePhoneBR(connectedPhone) || connectedPhone) : null

  // to/toPhone/recipientPhone: toJid = destinatário (nosso número quando recebemos, contato quando enviamos). Necessário para resolveConversationKeyFromZapi quando fromMe.
  const toPhoneDest = jidToDigits(toJid)
  const toPhoneNorm = toPhoneDest ? (normalizePhoneBR(toPhoneDest) || toPhoneDest) : null

  // Contato (vCard): UltraMsg envia type=vcard/contact e body com vCard; webhookZapi espera payload.contact
  const isContactType = ['vcard', 'contact', 'contactmessage'].includes(msgType)
  const vcardBody = (isContactType && bodyText && String(bodyText).includes('BEGIN:VCARD')) ? bodyText : (data.vcard ?? data.vCard ?? null)
  const contactPayload = (isContactType && (vcardBody || data.contact || data.contactMessageData)) ? {
    vCard: vcardBody || (data.contact?.vCard ?? data.contact?.vcard ?? data.contactMessageData?.vcard),
    displayName: data.contact?.displayName ?? data.contact?.formattedName ?? data.contactMessageData?.displayName ?? null,
    formattedName: data.contact?.formattedName ?? data.contact?.displayName ?? null
  } : undefined

  const nomeGrupoRaw = isGroup ? (data.chatName ?? data.chat?.name ?? data.subject ?? data.groupName ?? body.chatName ?? body.chat?.name ?? null) : null
  const chatName = nomeGrupoRaw ? String(nomeGrupoRaw).trim() : null

  const zapiLike = {
    instanceId: body.instanceId ?? body.instance_id,
    instance_id: body.instanceId ?? body.instance_id,
    fromMe,
    phone,
    remoteJid,
    isGroup,
    chatName: chatName || undefined,
    groupName: chatName || undefined,
    subject: chatName || undefined,
    to: !isGroup && toJid ? toJid : undefined,
    toPhone: !isGroup ? (toPhoneNorm || toPhoneDest || undefined) : undefined,
    recipientPhone: !isGroup ? (toPhoneNorm || toPhoneDest || undefined) : undefined,
    recipient: !isGroup && toJid ? toJid : undefined,
    messageId,
    zaapId: messageId,
    id: messageId,
    body: bodyText,
    message: bodyText,
    text: { message: bodyText },
    type: (msgType === 'ptt' ? 'audio' : (isContactType ? 'contact' : msgType)),
    participantPhone: participantPhone || undefined,
    participant: participantPhone ? `${participantPhone}@c.us` : undefined,
    key: {
      remoteJid: remoteJid || phone,
      fromMe,
      id: messageId,
      participant: isGroup ? fromJid : undefined
    },
    chatId: remoteJid,
    chat: { id: remoteJid, remoteJid },
    timestamp: data.time ? (Number(data.time) * 1000) : Date.now(),
    t: data.time,
    ack: (data.ack && String(data.ack).trim()) ? data.ack : 'pending',
    status: (data.ack && String(data.ack).trim()) ? data.ack : 'RECEIVED',
    imageUrl: imageUrl || null,
    documentUrl: documentUrl || null,
    audioUrl: audioUrl || null,
    videoUrl: videoUrl || null,
    stickerUrl: stickerUrl || null,
    senderName: senderName ? String(senderName).trim() : null,
    senderPhoto: senderPhoto && String(senderPhoto).trim().startsWith('http') ? String(senderPhoto).trim() : null,
    name: senderName ? String(senderName).trim() : null,
    notifyName: senderName ? String(senderName).trim() : null,
    pushName: senderName ? String(senderName).trim() : null,
    photo: senderPhoto && String(senderPhoto).trim().startsWith('http') ? String(senderPhoto).trim() : null,
    connectedPhone: connectedPhoneNorm || connectedPhone || undefined,
    ownerPhone: connectedPhoneNorm || connectedPhone || undefined,
    quotedMsg: quotedMsg || undefined,
    referenceMessageId: referenceMessageId || undefined,
    referencedMessage: quotedMsg ? { id: referenceMessageId, messageId: referenceMessageId, body: quotedMsg.body } : undefined,
    isForwarded: Boolean(data.isForwarded),
    isMentioned: Boolean(data.isMentioned),
    mentionedIds: Array.isArray(data.mentionedIds) ? data.mentionedIds : (data.mentionedIds ? [data.mentionedIds] : undefined),
    ultramsgHash: body.hash || undefined,
    ultramsgReferenceId: body.referenceId || undefined,
    ...(contactPayload ? { contact: { ...contactPayload, vCard: contactPayload.vCard || bodyText } } : {})
  }

  return zapiLike
}

function mapUltramsgAckToStatus(ack) {
  const s = String(ack ?? '').toLowerCase()
  // UltraMSG doc: pending, server, device, read, played
  if (s === 'sent' || s === 'server' || s === '1') return 'sent'
  if (s === 'delivered' || s === 'received' || s === 'device' || s === '2') return 'delivered'
  if (s === 'read' || s === 'seen' || s === '3') return 'read'
  if (s === 'played' || s === '4') return 'played'
  return s || 'pending'
}

exports.healthUltramsg = (req, res) => res.status(200).json({ ok: true, provider: 'ultramsg' })

exports.testarUltramsg = (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  const token = String(process.env.WHATSAPP_WEBHOOK_TOKEN || process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ''
  const webhookUrl = `${base}/webhooks/ultramsg${suffix}`
  return res.status(200).json({
    ok: true,
    provider: 'ultramsg',
    message: 'Configure no painel UltraMsg (Instance Settings → Webhook URL)',
    webhook_url: webhookUrl
  })
}

/** Tenta obter body válido — UltraMsg pode enviar JSON em campo string (ex: body.payload). */
function resolveWebhookBody(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.event_type || raw.eventType || raw.data) return raw
  const str = raw.payload ?? raw.body ?? raw.data
  if (typeof str === 'string' && str.trim().startsWith('{')) {
    try {
      return JSON.parse(str)
    } catch (_) {}
  }
  return raw
}

/**
 * Handler principal: normaliza payload UltraMsg → Z-API e delega ao webhookZapi.
 * Idempotência: webhookZapiController trata por (conversa_id, whatsapp_id).
 */
async function handleWebhookUltramsg(req, res) {
  try {
    let body = req.body
    body = resolveWebhookBody(body) || body
    if (!body || typeof body !== 'object') {
      req.webhookLogData = { status: 'ignored', error: 'payload_invalido' }
      console.warn('[WEBHOOK_ULTRAMSG] Payload inválido ou vazio — Content-Type:', req.get('content-type'))
      return res.status(200).json({ ok: true })
    }

    const ctx = req.zapiContext
    if (!ctx || ctx.company_id == null) {
      return res.status(200).json({ ok: true })
    }

    const eventType = String(body.event_type || body.eventType || '').toLowerCase()
    req.webhookLogData = {
      status: 'processed',
      company_id: ctx.company_id,
      instance_id: ctx.instanceId,
      event_type: eventType || ctx.eventType,
    }

    if (eventType === 'message_ack' || eventType === 'webhook_message_ack') {
      const normalized = normalizeUltramsgToZapi(body)
      if (!normalized) return res.status(200).json({ ok: true })
      req.body = { ...normalized, type: 'MessageStatusCallback', instanceId: body.instanceId, instance_id: body.instanceId }
      return webhookZapiController.statusZapi(req, res)
    }

    const isMessageEvent = [
      'message_received', 'message_create',
      'webhook_message_received', 'webhook_message_create',
      'webhook_message_download_media',
      'webhook_message_reaction', 'message_reaction',
      ''
    ].includes(eventType)
    const hasMessageData = body?.data && typeof body.data === 'object' && (body.data.from != null || body.data.id != null)
    if (isMessageEvent || hasMessageData) {
      const normalized = normalizeUltramsgToZapi(body)
      if (!normalized) return res.status(200).json({ ok: true })
      req.body = { ...normalized, type: 'ReceivedCallback', instanceId: body.instanceId, instance_id: body.instanceId }
      return webhookZapiController.receberZapi(req, res)
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    const errMsg = e?.message || String(e)
    console.error('[handleWebhookUltramsg]', errMsg)
    req.webhookLogData = { status: 'error', error_message: errMsg }
    return res.status(200).json({ ok: true })
  }
}

exports.handleWebhookUltramsg = handleWebhookUltramsg
