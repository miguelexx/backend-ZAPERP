const express = require('express')
const router = express.Router()
const webhookLogger = require('../middleware/webhookLogger')
const webhookController = require('../controllers/webhookController')
const { verifyMetaSignature } = require('../middleware/webhookAuth')

// GET — Meta exige para verificar a URL do webhook (Developer Console)
router.get('/', webhookLogger('meta'), webhookController.verificarWebhook)
// POST — recebe mensagens do WhatsApp
router.post('/', webhookLogger('meta'), verifyMetaSignature, webhookController.receberWebhook)

module.exports = router