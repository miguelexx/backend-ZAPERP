const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const { apiLimiter } = require('../middleware/rateLimit')
const zapiIntegrationController = require('../controllers/zapiIntegrationController')

// Integrações Z-API: supervisor e admin (atendente não gerencia conexão WhatsApp)
router.use(auth)
router.use(supervisorOrAdmin)
router.use(apiLimiter)

router.get('/me', zapiIntegrationController.getMe)
router.get('/debug-config', zapiIntegrationController.debugConfig)
router.get('/debug-status', zapiIntegrationController.debugStatus)

// Status da instância para empresa logada
router.get('/status', zapiIntegrationController.getStatus)

// Status operacional (conectado, sync, modo seguro)
router.get('/operational-status', zapiIntegrationController.getOperationalStatus)

// QR Code base64 (legado: retorna imageBase64)
router.get('/qrcode', zapiIntegrationController.getQrCodeLegacy)

// Reiniciar instância
router.post('/restart', zapiIntegrationController.restart)

// Fluxo Conectar WhatsApp — sub-rotas em /connect/*
const connectRouter = express.Router()
connectRouter.get('/status', zapiIntegrationController.getConnectStatus)
connectRouter.get('/qrcode', zapiIntegrationController.getQrCode)
connectRouter.post('/qrcode', zapiIntegrationController.getQrCode)
connectRouter.post('/restart', zapiIntegrationController.connectRestart)
connectRouter.post('/phone-code', zapiIntegrationController.phoneCode)
router.use('/connect', connectRouter)

// Sincronizar contatos do celular (Z-API GET /contacts ou fallback)
router.post('/contacts/sync', zapiIntegrationController.syncContacts)

module.exports = router

