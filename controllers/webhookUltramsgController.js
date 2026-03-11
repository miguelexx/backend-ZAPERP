/**
 * Webhook UltraMsg: recebe eventos e normaliza para formato Z-API.
 * Reutiliza a lógica de processamento do webhookZapiController.
 *
 * Formato UltraMsg: { event_type, instanceId, data: { id, from, to, body, type, fromMe, ... } }
 * Formato Z-API:   { phone, fromMe, messageId, text/message/body, key, ... }
 */

const { normalizeGroupIdForStorage } = require('../helpers/phoneHelper')
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

  if (eventType === 'message_ack') {
    return {
      instanceId: body.instanceId ?? body.instance_id,
      instance_id: body.instanceId ?? body.instance_id,
      messageId: data.id ?? data.msgId ?? null,
      zaapId: data.id ?? data.msgId ?? null,
      id: data.id ?? data.msgId ?? null,
      ack: data.ack ?? data.status ?? 'pending',
      status: mapUltramsgAckToStatus(data.ack ?? data.status),
      ids: data.id ? [data.id] : []
    }
  }

  if (!data || typeof data !== 'object') return body

  const fromMe = Boolean(data.fromMe)
  const fromJid = String(data.from || '').trim()
  const toJid = String(data.to || '').trim()
  const isGroup = toJid.endsWith('@g.us')

  let phone = ''
  let participantPhone = ''
  let remoteJid = ''

  if (isGroup) {
    remoteJid = toJid
    const groupDigits = jidToDigits(toJid)
    phone = groupDigits ? normalizeGroupIdForStorage(groupDigits) || groupDigits : toJid
    participantPhone = jidToDigits(fromJid) || ''
  } else {
    const contactJid = fromMe ? toJid : fromJid
    phone = normalizePhoneBR(jidToDigits(contactJid)) || jidToDigits(contactJid) || contactJid
    remoteJid = contactJid
  }

  const messageId = data.id ?? data.msgId ?? null
  const bodyText = data.body ?? data.text ?? data.message ?? ''
  const msgType = String(data.type || 'chat').toLowerCase()

  const zapiLike = {
    instanceId: body.instanceId ?? body.instance_id,
    instance_id: body.instanceId ?? body.instance_id,
    fromMe,
    phone,
    remoteJid,
    isGroup,
    messageId,
    zaapId: messageId,
    id: messageId,
    body: bodyText,
    message: bodyText,
    text: { message: bodyText },
    type: msgType,
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
    timestamp: data.time ? data.time * 1000 : Date.now(),
    t: data.time,
    ack: data.ack ?? 'pending',
    status: data.ack ?? 'RECEIVED',
    imageUrl: data.mediaUrl ?? data.image ?? null,
    documentUrl: data.documentUrl ?? data.document ?? null,
    audioUrl: data.audioUrl ?? data.audio ?? null,
    videoUrl: data.videoUrl ?? data.video ?? null,
    stickerUrl: data.stickerUrl ?? data.sticker ?? null
  }

  return zapiLike
}

function mapUltramsgAckToStatus(ack) {
  const s = String(ack ?? '').toLowerCase()
  if (s === 'sent' || s === '1') return 'sent'
  if (s === 'delivered' || s === 'received' || s === '2') return 'delivered'
  if (s === 'read' || s === 'seen' || s === '3') return 'read'
  if (s === 'played' || s === '4') return 'played'
  return s || 'pending'
}

/** Retorna payloads para processar (UltraMsg envia um por evento). */
function getPayloads(body) {
  if (!body || typeof body !== 'object') return []
  const normalized = normalizeUltramsgToZapi(body)
  return [normalized]
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

/**
 * Handler principal: normaliza payload UltraMsg → Z-API e delega ao webhookZapi.
 */
async function handleWebhookUltramsg(req, res) {
  try {
    const ctx = req.zapiContext
    if (!ctx || ctx.company_id == null) {
      return res.status(200).json({ ok: true })
    }

    const body = req.body || {}
    const eventType = String(body.event_type || body.eventType || '').toLowerCase()

    if (eventType === 'message_ack') {
      const normalized = normalizeUltramsgToZapi(body)
      req.body = { ...normalized, type: 'MessageStatusCallback', instanceId: body.instanceId, instance_id: body.instanceId }
      return webhookZapiController.statusZapi(req, res)
    }

    if (eventType === 'message_received' || eventType === 'message_create' || !eventType) {
      const normalized = normalizeUltramsgToZapi(body)
      req.body = { ...normalized, type: 'ReceivedCallback', instanceId: body.instanceId, instance_id: body.instanceId }
      return webhookZapiController.receberZapi(req, res)
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[handleWebhookUltramsg]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

exports.handleWebhookUltramsg = handleWebhookUltramsg
