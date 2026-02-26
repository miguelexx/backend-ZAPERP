/**
 * Rotas do webhook Z-API.
 *
 * Segurança (ajustada):
 *   - A validação por token FOI DESATIVADA para os POSTs de webhook,
 *     para permitir que a Z-API envie callbacks sem precisar de ?token=...
 *   - A validação de instanceId (rejectWrongZapiInstance) continua ativa,
 *     garantindo que apenas a instância correta da Z-API seja processada.
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')
const { rejectWrongZapiInstance } = require('../middleware/webhookAuth')
const requireWebhookToken = require('../middleware/requireWebhookToken')

// Loga TODA requisição POST que chega — para diagnosticar chamadas da Z-API
router.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log('[Z-API] Requisição POST', req.path || '/', '| IP:', req.ip || req.socket?.remoteAddress)
  }
  next()
})

// GET público — usado apenas para diagnóstico/healthcheck da URL configurada no Z-API
router.get('/', webhookZapiController.testarZapi)

// GET diagnóstico: mantém proteção por token (não é chamado pela Z-API)
router.get('/debug', requireWebhookToken, webhookZapiController.debugZapi)

// Callbacks Z-API: **SEM** validação de token, apenas instanceId
// Agora a Z-API pode chamar /webhooks/zapi sem ?token=...
router.post('/',           rejectWrongZapiInstance, webhookZapiController.receberZapi)
router.post('/status',     rejectWrongZapiInstance, webhookZapiController.statusZapi)
router.post('/connection', rejectWrongZapiInstance, webhookZapiController.connectionZapi)
router.post('/presence',   rejectWrongZapiInstance, webhookZapiController.presenceZapi)

module.exports = router
