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
// Assim você vê no PM2/Docker se a Z-API está batendo no backend (qualquer réplica).
router.use((req, res, next) => {
  if (req.method === 'POST') {
    const ip = req.ip || req.socket?.remoteAddress || '?'
    const instanceId = req.body?.instanceId != null ? String(req.body.instanceId).slice(0, 20) : '(vazio)'
    console.log('[Z-API] POST', req.path || '/', '| IP:', ip, '| instanceId:', instanceId)
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
