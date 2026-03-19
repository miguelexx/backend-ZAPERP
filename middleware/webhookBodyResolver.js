'use strict'

/**
 * Resolve body do webhook UltraMsg.
 * Alguns provedores enviam JSON em campo string (ex: body.payload ou form-urlencoded).
 * Deve rodar ANTES de requireWebhookToken e resolveWebhookZapi para que instanceId seja extraído corretamente.
 */
function webhookBodyResolver(req, res, next) {
  if (req.method !== 'POST') return next()
  let body = req.body
  if (!body || typeof body !== 'object') return next()
  if (body.event_type || body.eventType || (body.data && typeof body.data === 'object')) return next()

  const str = body.payload ?? body.body ?? body.data
  if (typeof str === 'string' && str.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(str)
      if (parsed && typeof parsed === 'object') {
        req.body = parsed
      }
    } catch (_) {}
  }
  next()
}

module.exports = webhookBodyResolver
