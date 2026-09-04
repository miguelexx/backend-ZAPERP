/**
 * Rotas do webhook Whapi Cloud (2º provider).
 * POST /webhooks/whapi — eventos messages[] / statuses[].
 * Resolve company_id por channel_id (provider='whapi') antes do processamento.
 * Auth: requireWebhookToken (timing-safe) via header X-Webhook-Token / Authorization: Bearer — NUNCA ?token= na query.
 * NÃO reutiliza /webhooks/whatsapp (esse é UltraMSG). Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const express = require('express')
const router = express.Router()
const webhookLogger = require('../middleware/webhookLogger')
const webhookBodyResolver = require('../middleware/webhookBodyResolver')
const requireWebhookToken = require('../middleware/requireWebhookToken')
const resolveWhapiWebhookCompany = require('../middleware/resolveWhapiWebhookCompany')
const webhookWhapiController = require('../controllers/webhookWhapiController')

router.get('/health', webhookWhapiController.healthWhapi)
router.get('/', webhookWhapiController.testarWhapi)

const webhookStack = [
  webhookLogger('whapi'),
  webhookBodyResolver,
  requireWebhookToken,
  resolveWhapiWebhookCompany,
  webhookWhapiController.handleWebhookWhapi,
]
router.post('/', webhookStack)

module.exports = router
