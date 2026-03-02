const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const { apiLimiter } = require('../middleware/rateLimit')
const zapiIntegrationController = require('../controllers/zapiIntegrationController')

// Todas as rotas exigem usuário autenticado.
router.use(auth)
router.use(apiLimiter)

// Opcional: diagnóstico /me
router.get('/me', zapiIntegrationController.getMe)

// Status da instância para empresa logada
router.get('/status', zapiIntegrationController.getStatus)

// QR Code base64
router.get('/qrcode', zapiIntegrationController.getQrCode)

// Reiniciar instância
router.post('/restart', zapiIntegrationController.restart)

module.exports = router

