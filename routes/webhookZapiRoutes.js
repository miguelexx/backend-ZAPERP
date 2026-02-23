/**
 * Rotas do webhook Z-API.
 * (Sem exigência de token — Z-API chama diretamente essas URLs.)
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')
const { rejectWrongZapiInstance } = require('../middleware/webhookAuth')

// Loga TODA requisição POST que chega — para diagnosticar chamadas da Z-API
router.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log('[Z-API] Requisição POST', req.path || '/', '| IP:', req.ip || req.socket?.remoteAddress)
  }
  next()
})

// GET público — usado apenas para diagnóstico/healthcheck da URL configurada no Z-API
router.get('/', webhookZapiController.testarZapi)

// Callbacks Z-API sem validação de token
router.post('/',           rejectWrongZapiInstance, webhookZapiController.receberZapi)
router.post('/status',     rejectWrongZapiInstance, webhookZapiController.statusZapi)
router.post('/connection', rejectWrongZapiInstance, webhookZapiController.connectionZapi)
router.post('/presence',   rejectWrongZapiInstance, webhookZapiController.presenceZapi)

module.exports = router
