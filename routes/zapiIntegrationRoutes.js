const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const { apiLimiter } = require('../middleware/rateLimit')
const zapiIntegrationController = require('../controllers/zapiIntegrationController')

// Todas as rotas exigem usuário autenticado.
router.use(auth)
router.use(apiLimiter)

router.get('/me', zapiIntegrationController.getMe)
router.get('/debug-config', zapiIntegrationController.debugConfig)
router.get('/debug-status', zapiIntegrationController.debugStatus)

// Status da instância para empresa logada
router.get('/status', zapiIntegrationController.getStatus)

// QR Code base64 (legado: retorna imageBase64)
router.get('/qrcode', zapiIntegrationController.getQrCodeLegacy)

// Reiniciar instância
router.post('/restart', zapiIntegrationController.restart)

// Fluxo Conectar WhatsApp — sub-rotas em /connect/*
const connectRouter = express.Router()
connectRouter.get('/status', zapiIntegrationController.getConnectStatus)
connectRouter.post('/qrcode', zapiIntegrationController.getQrCode)
connectRouter.get('/qrcode', zapiIntegrationController.getQrCode)
connectRouter.post('/restart', zapiIntegrationController.connectRestart)
connectRouter.post('/phone-code', zapiIntegrationController.phoneCode)
router.use('/connect', connectRouter)

// Sincronizar contatos do celular (Z-API GET /contacts ou fallback)
router.post('/contacts/sync', zapiIntegrationController.syncContacts)

module.exports = router

