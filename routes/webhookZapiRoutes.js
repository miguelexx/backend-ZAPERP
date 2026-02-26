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

// Log ANTES de qualquer validação: método, URL, headers e body size.
// Ajuda a ver se: (1) o body chega vazio por parser/headers, (2) path está diferente (nginx prefix).
router.use((req, res, next) => {
  if (req.method === 'POST') {
    const ip = req.ip || req.socket?.remoteAddress || '?'
    const method = req.method
    const url = req.originalUrl || req.url || req.path || '/'
    const contentType = req.get('content-type') || '(vazio)'
    const userAgent = req.get('user-agent') || '(vazio)'
    const contentLength = req.get('content-length') != null ? req.get('content-length') : '(vazio)'
    const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body).length : 0
    console.log('[Z-API] INCOMING:', {
      method,
      url,
      ip,
      'content-type': contentType,
      'content-length': contentLength,
      'user-agent': userAgent?.slice(0, 60),
      bodyKeys
    })
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
