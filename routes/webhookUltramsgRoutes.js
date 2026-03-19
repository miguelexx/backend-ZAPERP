/**
 * Rotas do webhook UltraMsg.
 * POST /webhooks/ultramsg — recebe eventos (message_received, message_ack).
 * Reutiliza resolveWebhookZapi (instanceId → company_id via empresa_zapi).
 * webhookLogger registra todos os webhooks em webhook_logs.
 */

const express = require('express')
const router = express.Router()
const webhookLogger = require('../middleware/webhookLogger')
const webhookBodyResolver = require('../middleware/webhookBodyResolver')
const webhookUltramsgController = require('../controllers/webhookUltramsgController')
const requireWebhookToken = require('../middleware/requireWebhookToken')
const resolveWebhookZapi = require('../middleware/resolveWebhookZapi')

router.get('/health', webhookUltramsgController.healthUltramsg)
router.get('/', webhookUltramsgController.testarUltramsg)

const webhookStack = [webhookLogger('ultramsg'), webhookBodyResolver, requireWebhookToken, resolveWebhookZapi, webhookUltramsgController.handleWebhookUltramsg]
router.post('/', webhookStack)

module.exports = router
