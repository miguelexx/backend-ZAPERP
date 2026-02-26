/**
 * Rotas do webhook Z-API.
 *
 * Segurança:
 *   - requireWebhookToken: valida ?token=<ZAPI_WEBHOOK_TOKEN> que a Z-API envia de volta.
 *     A URL registrada no painel Z-API inclui o token como query-param (configureWebhooks).
 *   - rejectWrongZapiInstance: rejeita instanceId diferente do configurado no .env.
 *
 * O token é configurado via ZAPI_WEBHOOK_TOKEN no .env e incluído automaticamente
 * nas URLs registradas na Z-API pelo configureWebhooks em services/providers/zapi.js.
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

// GET diagnóstico: protegido por token (evita expor payloads de webhook publicamente)
router.get('/debug', requireWebhookToken, webhookZapiController.debugZapi)

// Callbacks Z-API: validação de token + validação de instanceId
router.post('/',           requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.receberZapi)
router.post('/status',     requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.statusZapi)
router.post('/connection', requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.connectionZapi)
router.post('/presence',   requireWebhookToken, rejectWrongZapiInstance, webhookZapiController.presenceZapi)

module.exports = router
