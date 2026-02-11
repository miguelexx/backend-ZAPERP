/**
 * Rotas do webhook Z-API (sem autenticação — chamadas pelo servidor Z-API).
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')

router.get('/', webhookZapiController.testarZapi)
router.post('/', webhookZapiController.receberZapi)
router.post('/status', webhookZapiController.statusZapi)
router.post('/connection', webhookZapiController.connectionZapi)
router.post('/presence', webhookZapiController.presenceZapi)

module.exports = router
