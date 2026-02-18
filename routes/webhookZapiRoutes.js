/**
 * Rotas do webhook Z-API (sem autenticação — chamadas pelo servidor Z-API).
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')
const { verifyZapiToken, rejectWrongZapiInstance } = require('../middleware/webhookAuth')

router.get('/', webhookZapiController.testarZapi)
router.post('/', verifyZapiToken, rejectWrongZapiInstance, webhookZapiController.receberZapi)
router.post('/status', verifyZapiToken, rejectWrongZapiInstance, webhookZapiController.statusZapi)
router.post('/connection', verifyZapiToken, rejectWrongZapiInstance, webhookZapiController.connectionZapi)
router.post('/presence', verifyZapiToken, rejectWrongZapiInstance, webhookZapiController.presenceZapi)

module.exports = router
