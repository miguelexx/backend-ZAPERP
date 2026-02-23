/**
 * Rotas do webhook Z-API.
 * Todos os endpoints POST exigem token via requireWebhookToken (fail-closed).
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')
const requireWebhookToken = require('../middleware/requireWebhookToken')
const { rejectWrongZapiInstance } = require('../middleware/webhookAuth')

// Loga TODA requisição POST que chega (antes de validar token) — para saber se a Z-API está chamando
router.use((req, res, next) => {
  if (req.method === 'POST') {
    const hasToken = !!(req.query?.token || req.get('X-Webhook-Token'))
    console.log('[Z-API] Requisição POST', req.path || '/', '| token presente:', hasToken, '| IP:', req.ip || req.socket?.remoteAddress)
  }
  next()
})

// GET público — usado apenas para diagnóstico/healthcheck da URL configurada no Z-API
router.get('/', webhookZapiController.testarZapi)

// Todos os callbacks Z-API protegidos com token obrigatório (header X-Webhook-Token ou ?token=)
router.post('/',           requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.receberZapi)
router.post('/status',     requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.statusZapi)
router.post('/connection', requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.connectionZapi)
router.post('/presence',   requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.presenceZapi)

module.exports = router
