/**
 * Legacy webhook controller kept only as a fail-closed compatibility shim.
 *
 * Active WhatsApp webhooks are mounted through routes/webhookUltramsgRoutes.js,
 * which resolves company_id from the provider instance context. This legacy
 * controller must never infer or hard-code company_id.
 */

exports.receberWebhook = async (_req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'Webhook legado desativado. Use /webhooks/ultramsg ou /webhooks/whatsapp.',
  })
}
