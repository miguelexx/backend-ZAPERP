/**
 * Rotas do webhook Z-API.
 *
 * Endpoint principal: POST /webhooks/zapi — aceita QUALQUER evento e roteia por payload.type.
 * Aliases (compatibilidade com painel): /connection, /status, /presence, /disconnected.
 *
 * Segurança: POST /webhooks/zapi* NÃO exige token. Validação via instanceId + empresa_zapi.
 * GET /debug exige token. Rate-limit por IP (60 req/min). Mapeamento case-insensitive.
 */

const express = require('express')
const router = express.Router()
const webhookZapiController = require('../controllers/webhookZapiController')
const requireWebhookToken = require('../middleware/requireWebhookToken')
const resolveWebhookZapi = require('../middleware/resolveWebhookZapi')

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

router.get('/health', webhookZapiController.healthZapi)
router.get('/', webhookZapiController.testarZapi)
router.get('/debug', requireWebhookToken, webhookZapiController.debugZapi)

// Stack: resolve instanceId→company_id (sem token obrigatório) -> handler unificado
// Segurança: instanceId obrigatório; mapeamento empresa_zapi; rate-limit por IP (app.js)
const webhookStack = [resolveWebhookZapi, webhookZapiController.handleWebhookZapi]

router.post('/', webhookStack)
router.post('/connection', webhookStack)
router.post('/status', webhookStack)
router.post('/presence', webhookStack)
router.post('/disconnected', webhookStack)

module.exports = router
