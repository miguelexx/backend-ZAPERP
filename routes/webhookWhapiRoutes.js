/**
 * Rotas do webhook Whapi Cloud (2º provider).
 * POST /webhooks/whapi — eventos messages[] / statuses[].
 * Resolve company_id por channel_id (provider='whapi') antes do processamento.
 * Auth: requireWhapiWebhookToken (timing-safe, dedicado) via header X-Webhook-Token / Authorization: Bearer — NUNCA ?token= na query, sem fallback UltraMSG.
 * NÃO reutiliza /webhooks/whatsapp (esse é UltraMSG). Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const express = require('express')
const router = express.Router()
const webhookLogger = require('../middleware/webhookLogger')
const webhookBodyResolver = require('../middleware/webhookBodyResolver')
const requireWhapiWebhookToken = require('../middleware/requireWhapiWebhookToken')
const resolveWhapiWebhookCompany = require('../middleware/resolveWhapiWebhookCompany')
const webhookWhapiController = require('../controllers/webhookWhapiController')

router.get('/health', webhookWhapiController.healthWhapi)
router.get('/', webhookWhapiController.testarWhapi)

const webhookStack = [
  webhookLogger('whapi'),
  webhookBodyResolver,
  requireWhapiWebhookToken,
  resolveWhapiWebhookCompany,
  webhookWhapiController.handleWebhookWhapi,
]
router.post('/', webhookStack)

module.exports = router
