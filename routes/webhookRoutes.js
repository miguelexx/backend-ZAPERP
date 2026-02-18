const express = require('express')
const router = express.Router()
const webhookController = require('../controllers/webhookController')
const { verifyMetaSignature } = require('../middleware/webhookAuth')

// GET — Meta exige para verificar a URL do webhook (Developer Console)
router.get('/', webhookController.verificarWebhook)
// POST — recebe mensagens do WhatsApp
router.post('/', verifyMetaSignature, webhookController.receberWebhook)

module.exports = router