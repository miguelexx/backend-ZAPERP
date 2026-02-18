const crypto = require('crypto')

function timingSafeEqual(a, b) {
  const sa = String(a || '')
  const sb = String(b || '')
  const ba = Buffer.from(sa)
  const bb = Buffer.from(sb)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// Meta / WhatsApp Cloud API: X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(appSecret, rawBody)
function verifyMetaSignature(req, res, next) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const appSecret = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || ''

  // Em prod, exigir segredo configurado (fail-closed)
  if (isProd && !appSecret) {
    return res.status(500).json({ error: 'WEBHOOK: META_APP_SECRET/WHATSAPP_APP_SECRET não configurado' })
  }
  // Em dev, se não tiver segredo, não bloqueia
  if (!appSecret) return next()

  const header = req.get('x-hub-signature-256') || req.get('X-Hub-Signature-256') || ''
  if (!header || !String(header).startsWith('sha256=')) {
    return res.status(401).json({ error: 'Assinatura do webhook ausente' })
  }

  const raw = req.rawBody
  if (!raw || !Buffer.isBuffer(raw)) {
    // sem raw body, não é seguro validar — bloqueia em prod
    if (isProd) return res.status(500).json({ error: 'WEBHOOK: rawBody ausente (config express.json verify)' })
    return next()
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex')
  if (!timingSafeEqual(header, expected)) {
    return res.status(401).json({ error: 'Assinatura do webhook inválida' })
  }
  return next()
}

// Z-API: token simples por header ou query (?token=)
function verifyZapiToken(req, res, next) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  const token = String(process.env.ZAPI_WEBHOOK_TOKEN || process.env.WEBHOOK_ZAPI_TOKEN || '').trim()

  if (isProd && !token) {
    return res.status(500).json({ error: 'WEBHOOK: ZAPI_WEBHOOK_TOKEN/WEBHOOK_ZAPI_TOKEN não configurado' })
  }
  if (!token) return next()

  const incoming =
    String(req.get('x-webhook-token') || '').trim() ||
    String(req.query?.token || '').trim() ||
    String(req.query?.key || '').trim()

  if (!incoming || !timingSafeEqual(incoming, token)) {
    return res.status(401).json({ error: 'Token do webhook inválido' })
  }
  return next()
}

function rejectWrongZapiInstance(req, res, next) {
  const expected = String(process.env.ZAPI_INSTANCE_ID || '').trim()
  if (!expected) return next()
  const incoming = req.body?.instanceId != null ? String(req.body.instanceId).trim() : ''
  // se não veio instanceId, não bloqueia (alguns eventos não mandam)
  if (incoming && incoming !== expected) {
    return res.status(200).json({ ok: true })
  }
  return next()
}

module.exports = { verifyMetaSignature, verifyZapiToken, rejectWrongZapiInstance }

