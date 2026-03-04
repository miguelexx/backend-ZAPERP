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

/**
 * Multi-tenant: não rejeitamos por instanceId aqui.
 * O controller resolve company_id por instanceId em empresa_zapi.
 * Se não mapeado, retorna 200 e loga "instance not mapped".
 */
function rejectWrongZapiInstance(req, res, next) {
  return next()
}

module.exports = { verifyMetaSignature, rejectWrongZapiInstance }

