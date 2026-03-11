/**
 * Rotas do webhook UltraMsg.
 * POST /webhooks/ultramsg — recebe eventos (message_received, message_ack).
 * Reutiliza resolveWebhookZapi (instanceId → company_id via empresa_zapi).
 */

const express = require('express')
const router = express.Router()
const webhookUltramsgController = require('../controllers/webhookUltramsgController')
const requireWebhookToken = require('../middleware/requireWebhookToken')
const resolveWebhookZapi = require('../middleware/resolveWebhookZapi')

router.get('/health', webhookUltramsgController.healthUltramsg)
router.get('/', webhookUltramsgController.testarUltramsg)

const webhookStack = [requireWebhookToken, resolveWebhookZapi, webhookUltramsgController.handleWebhookUltramsg]
router.post('/', webhookStack)

module.exports = router
