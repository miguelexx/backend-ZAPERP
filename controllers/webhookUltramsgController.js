/**
 * Webhook UltraMSG: recebe eventos e normaliza para um formato interno unificado
 * consumido pelo pipeline de mensagens (`webhookZapiController` — nome de ficheiro legado; ver ../docs/_OFICIAL/ADR-LEGACY-NAMING.md).
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
 * Formato interno unificado (histórico): { phone, fromMe, messageId, text/message/body, key, ... }
 */

const { normalizePhoneBR } = require('../helpers/phoneHelper')
const webhookCoreController = require('./webhookZapiController')

/** Extrai dígitos de JID (55349999@c.us → 55349999, 120363@g.us → 120363) */
function jidToDigits(jid) {
  if (!jid || typeof jid !== 'string') return ''
  return String(jid).replace(/@[^@]+$/, '').replace(/\D/g, '')
}

/** Converte payload UltraMsg para o formato interno esperado pelo pipeline legado de mensagens. */
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
  // type bruto: aparelhos/versões de WhatsApp variam — já vimos 'ptt', 'audio' e derivados.
  // Variantes fora do par exato audio/ptt (ex.: 'voice', 'audiomessage') derrubavam o tipo e a
  // mensagem virava "(mensagem)" sem conteúdo SÓ para os contatos daquele aparelho.
  const msgTypeRaw = String(data.type || '').toLowerCase().trim()
  let msgType = msgTypeRaw || 'chat'
  if (['voice', 'voicemessage', 'audiomessage', 'pttmessage'].includes(msgType)) msgType = 'ptt'
  else if (['imagemessage', 'photo', 'picture'].includes(msgType)) msgType = 'image'
  else if (['videomessage', 'gif'].includes(msgType)) msgType = 'video'
  else if (['stickermessage'].includes(msgType)) msgType = 'sticker'

  /** Normaliza campo de mídia (string URL ou objeto com url/link/file) para string URL. */
  const toUrl = (v) => {
    if (!v) return null
    if (typeof v === 'string' && v.trim().startsWith('http')) return v.trim()
    if (typeof v === 'object' && v != null) return v.url ?? v.link ?? v.file ?? (v.src && String(v.src).startsWith('http') ? v.src : null) ?? null
    return null
  }

  // data.media: UltraMSG envia string URL ou objeto { url, link, file } para imagem/áudio/vídeo/documento
  // webhook_message_download_media=true: UltraMsg inclui URL da mídia no payload
  const mediaUrl = toUrl(data.media) ?? toUrl(data.mediaUrl)

  // Inferência de tipo quando o type vem ausente/genérico ou como MIME cru ('audio/ogg; codecs=opus'):
  // usa mimetype do payload, o próprio type-como-MIME e a extensão da URL da mídia.
  // NUNCA reclassifica um type já reconhecido — só resgata payloads que cairiam em "(mensagem)"
  // com a URL da mídia descartada.
  const mimeHint =
    String(data.mimetype ?? data.mime_type ?? data.media?.mimetype ?? data.media?.mime_type ?? '')
      .toLowerCase().trim() ||
    (msgTypeRaw.includes('/') ? msgTypeRaw : '')
  const msgTypeGenerico = !msgTypeRaw || ['chat', 'text', 'message'].includes(msgType) || msgTypeRaw.includes('/')
  if (msgTypeGenerico && (mediaUrl || mimeHint)) {
    const urlPath = String(mediaUrl || '').split(/[?#]/)[0].toLowerCase()
    if (mimeHint.startsWith('audio/') || /\.(ogg|oga|opus|mp3|m4a|aac|amr|wav)$/.test(urlPath)) {
      msgType = 'ptt'
    } else if (mimeHint.startsWith('image/webp') || /\.webp$/.test(urlPath)) {
      msgType = 'sticker'
    } else if (mimeHint.startsWith('image/') || /\.(jpe?g|png|gif|bmp|heic)$/.test(urlPath)) {
      msgType = 'image'
    } else if (mimeHint.startsWith('video/') || /\.(mp4|mov|3gp|webm|mkv)$/.test(urlPath)) {
      msgType = 'video'
    } else if (mediaUrl && (mimeHint.startsWith('application/') || /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|rtf)$/.test(urlPath))) {
      msgType = 'document'
    }
    if (msgType !== 'chat' && msgType !== msgTypeRaw) {
      console.log('[WEBHOOK_ULTRAMSG] tipo inferido por mime/URL (type bruto não reconhecido)', {
        type_bruto: (msgTypeRaw || '(vazio)').slice(0, 40),
        mime: mimeHint.slice(0, 40) || null,
        inferido: msgType,
        has_media: !!mediaUrl,
      })
    }
  }

  // Áudio: data.audio, data.audioUrl, data.mediaUrl, data.media, data.attachment (UltraMsg pode variar)
  let audioUrl =
    toUrl(data.audio) ??
    toUrl(data.audioUrl) ??
    toUrl(data.attachment) ??
    (msgType === 'audio' || msgType === 'ptt' ? (mediaUrl ?? toUrl(data.file)) : null)

  // Nome do arquivo: UltraMSG envia filename/caption no webhook de documentos (changelog Apr 2023).
  // Sem isto, o pipeline interno nunca recebe fileName e grava só o texto do body (ex.: "relatorio.docx").
  const looksLikeFileName = (v) => {
    const s = String(v || '').trim()
    if (!s || s.length > 255 || /\n/.test(s)) return false
    return /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|7z|rtf|odt|ods|odp|json|xml|apk|bin)$/i.test(s)
  }
  const fileNameRaw =
    data.filename ??
    data.fileName ??
    data.file_name ??
    data.document?.filename ??
    data.document?.fileName ??
    data.document?.title ??
    data.file?.filename ??
    data.file?.fileName ??
    data.media?.filename ??
    data.media?.fileName ??
    null
  let fileName = fileNameRaw ? String(fileNameRaw).trim() : null
  if (!fileName && looksLikeFileName(bodyText)) {
    fileName = String(bodyText).trim()
  }
  const captionRaw = data.caption ?? data.document?.caption ?? null
  const documentCaption = captionRaw && String(captionRaw).trim() ? String(captionRaw).trim() : null
  const declaredDocumentType = msgType === 'document' || msgType === 'file' || msgType === 'documentmessage'
  // UltraMSG às vezes manda type=chat com body=arquivo.docx (+ media) — tratar como documento.
  // Também: type=chat só com filename no body (URL chega depois em webhook_message_download_media).
  // Aceita nomes com espaços (ex.: "Ofício Dr. 13 - EMOF.docx"); evita frases longas.
  // Só inferir a partir de chat/text — nunca reclassificar image/audio/video/sticker.
  const canInferDocument = !msgType || msgType === 'chat' || msgType === 'text' || msgType === 'message'
  const bodyLooksLikeStandaloneFile =
    looksLikeFileName(bodyText) &&
    String(bodyText).trim().length <= 200 &&
    !/\n/.test(String(bodyText)) &&
    !/\s+(https?:\/\/|www\.)/i.test(String(bodyText))
  const inferredDocument = canInferDocument && !declaredDocumentType && (
    !!fileNameRaw ||
    (!!mediaUrl && (!!fileName || bodyLooksLikeStandaloneFile)) ||
    bodyLooksLikeStandaloneFile
  )
  const isDocumentType = declaredDocumentType || inferredDocument

  // Mídia por tipo: UltraMSG doc — media (URL) é o campo principal; mediaUrl, document/file, etc. como fallback
  const imageUrl = msgType === 'image' ? (mediaUrl ?? toUrl(data.image)) : toUrl(data.image)
  const documentUrl =
    toUrl(data.documentUrl) ??
    toUrl(data.document) ??
    toUrl(data.file) ??
    toUrl(data.attachment) ??
    (isDocumentType ? mediaUrl : null)
  const videoUrl = msgType === 'video' ? (mediaUrl ?? toUrl(data.videoUrl) ?? toUrl(data.video)) : (toUrl(data.videoUrl) ?? toUrl(data.video))
  const stickerUrl = msgType === 'sticker' ? (mediaUrl ?? toUrl(data.stickerUrl) ?? toUrl(data.sticker)) : (toUrl(data.stickerUrl) ?? toUrl(data.sticker))

  const effectiveMsgType = isDocumentType
    ? 'document'
    : (msgType === 'documentmessage' ? 'document' : msgType)

  // Body do documento: preferir caption real; se body for só o filename, manter filename (UI/lista)
  const documentBodyText = isDocumentType
    ? (documentCaption || (fileName && String(bodyText).trim() === fileName ? fileName : (String(bodyText || '').trim() || fileName || '')))
    : bodyText

  // Localização: UltraMsg envia type=location com lat/lng (ou latitude/longitude).
  // UltraMSG pode enviar: data.lat/data.lng no root, ou data.location = { lat, lng, address }.
  // IMPORTANTE: data.body para location pode conter Base64 do thumbnail (imagem estática do mapa) —
  // NUNCA usar body como address quando for Base64 (ex: /9j/4AAQ = JPEG base64).
  const isLocationType = ['location', 'loc', 'geo'].includes(msgType)
  const locData = data.location && typeof data.location === 'object' ? data.location : data
  const locLat = locData.lat ?? locData.latitude ?? data.lat ?? data.latitude
  const locLng = locData.lng ?? locData.longitude ?? data.lng ?? data.longitude
  const isBodyBase64Image = (v) => {
    if (!v || typeof v !== 'string') return false
    const s = String(v).trim()
    return s.startsWith('/9j/') || s.startsWith('iVB') || s.startsWith('data:image') ||
      (s.length > 200 && /^[A-Za-z0-9+/=]+$/.test(s))
  }
  const locAddress = locData.address ?? data.address ?? ''
  const locName = locData.name ?? locData.nameLocation ?? data.name ?? data.nameLocation ?? ''
  const safeAddress = (locAddress && String(locAddress).trim()) || (!isBodyBase64Image(bodyText) && bodyText && String(bodyText).length < 300 ? String(bodyText).trim() : '')
  const locationPayload = (isLocationType && (locLat != null || locLng != null)) ? {
    latitude: Number(locLat) || 0,
    longitude: Number(locLng) || 0,
    address: safeAddress,
    name: (locName && String(locName).trim()) || '',
    url: (locLat != null && locLng != null && !isNaN(Number(locLat)) && !isNaN(Number(locLng)))
      ? `https://www.google.com/maps?q=${Number(locLat)},${Number(locLng)}`
      : undefined
  } : undefined

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

  // Reação: UltraMsg envia event_type=webhook_message_reaction/message_reaction (ou data.type=reaction).
  // O emoji costuma vir no body; o alvo (mensagem reagida) no quotedMsg/reactionMessage.
  // Guarda forte: só trata como reação em evento comprovadamente de reação — nunca reclassifica texto/mídia.
  // Sem emoji detectável, degrada para o comportamento atual (pipeline gera "Reação").
  const isReactionEvent = eventType.includes('reaction') || msgType === 'reaction' || msgType === 'reactionmessage'
  const reactionEmojiRaw = isReactionEvent
    ? (data.reaction?.emoji ?? data.reaction?.text ?? data.reaction?.value ?? data.emoji
        ?? (bodyText && String(bodyText).trim().length > 0 && String(bodyText).trim().length <= 16 ? String(bodyText).trim() : ''))
    : ''
  const reactionTargetId = isReactionEvent
    ? (data.reaction?.messageId ?? data.reaction?.msgId ?? data.reactionMessage?.id ?? referenceMessageId ?? (quotedMsg ? quotedMsg.id : null) ?? null)
    : null
  const reactionPayload = isReactionEvent
    ? { value: reactionEmojiRaw || '', emoji: reactionEmojiRaw || '', time: data.time ?? null, messageId: reactionTargetId }
    : null

  // connectedPhone: nosso número (to quando recebemos, from quando enviamos) — necessário para resolveConversationKeyFromZapi
  const connectedPhone = fromMe ? jidToDigits(fromJid) : jidToDigits(toJid)
  const connectedPhoneNorm = connectedPhone ? (normalizePhoneBR(connectedPhone) || connectedPhone) : null

  // to/toPhone/recipientPhone: toJid = destinatário (nosso número quando recebemos, contato quando enviamos). Necessário para resolveConversationKeyFromZapi quando fromMe.
  const toPhoneDest = jidToDigits(toJid)
  const toPhoneNorm = toPhoneDest ? (normalizePhoneBR(toPhoneDest) || toPhoneDest) : null

  // Contato (vCard): UltraMSG envia type=vcard/contact e body com vCard; o pipeline interno espera payload.contact
  // Fallback: body contém BEGIN:VCARD mesmo com type=chat (alguns provedores enviam assim)
  const hasVcardInBody = bodyText && String(bodyText).includes('BEGIN:VCARD') && String(bodyText).includes('END:VCARD')
  const isContactType = ['vcard', 'contact', 'contactmessage'].includes(msgType) || hasVcardInBody
  const vcardBody = (isContactType && bodyText && String(bodyText).includes('BEGIN:VCARD')) ? bodyText : (data.vcard ?? data.vCard ?? null)
  const contactPayload = (isContactType && (vcardBody || data.contact || data.contactMessageData)) ? {
    vCard: vcardBody || (data.contact?.vCard ?? data.contact?.vcard ?? data.contactMessageData?.vcard),
    displayName: data.contact?.displayName ?? data.contact?.formattedName ?? data.contactMessageData?.displayName ?? null,
    formattedName: data.contact?.formattedName ?? data.contact?.displayName ?? null
  } : undefined

  const nomeGrupoRaw = isGroup ? (data.chatName ?? data.chat?.name ?? data.subject ?? data.groupName ?? body.chatName ?? body.chat?.name ?? null) : null
  const chatName = nomeGrupoRaw ? String(nomeGrupoRaw).trim() : null

  // Para localização: se body for Base64 (thumbnail do mapa), usar texto descritivo em vez do Base64
  const validCoords = locLat != null && locLng != null && !isNaN(Number(locLat)) && !isNaN(Number(locLng))
  const bodySource = isDocumentType ? documentBodyText : bodyText
  const bodyForPayload = (locationPayload && isBodyBase64Image(bodyText))
    ? (safeAddress || (validCoords ? `${locLat},${locLng}` : null) || '(localização)')
    : bodySource

  const resolvedType = msgType === 'ptt'
    ? 'audio'
    : (isReactionEvent ? 'reaction' : (isContactType ? 'contact' : effectiveMsgType))

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
    body: bodyForPayload,
    message: bodyForPayload,
    text: { message: bodyForPayload },
    type: resolvedType,
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
    fileName: fileName || null,
    filename: fileName || null,
    ...(isDocumentType && (documentUrl || fileName) ? {
      document: {
        documentUrl: documentUrl || undefined,
        url: documentUrl || undefined,
        fileName: fileName || undefined,
        filename: fileName || undefined,
        caption: documentCaption || undefined,
        title: fileName || undefined,
      }
    } : {}),
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
    ...(contactPayload ? { contact: { ...contactPayload, vCard: contactPayload.vCard || bodyText } } : {}),
    ...(locationPayload ? { location: locationPayload } : {}),
    ...(reactionPayload ? { reaction: reactionPayload } : {})
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
  const webhookUrl = `${base}/webhooks/ultramsg?token=<WHATSAPP_WEBHOOK_TOKEN>`
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
 * Handler principal: normaliza payload UltraMSG e delega ao pipeline interno (webhookZapiController).
 * Idempotência: controlador central trata por (conversa_id, whatsapp_id).
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
      return webhookCoreController.statusZapi(req, res)
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
      return webhookCoreController.receberZapi(req, res)
    }

    console.warn('[WEBHOOK_ULTRAMSG] evento não encaminhado ao pipeline de mensagens', {
      company_id: ctx.company_id,
      event_type: eventType || '(vazio)',
      hasMessageData,
      bodyKeys: Object.keys(body || {}).slice(0, 20),
    })
    return res.status(200).json({ ok: true })
  } catch (e) {
    const errMsg = e?.message || String(e)
    console.error('[handleWebhookUltramsg]', errMsg)
    req.webhookLogData = { status: 'error', error_message: errMsg }
    return res.status(200).json({ ok: true })
  }
}

exports.handleWebhookUltramsg = handleWebhookUltramsg
exports._test = { normalizeUltramsgToZapi, resolveWebhookBody, mapUltramsgAckToStatus }
