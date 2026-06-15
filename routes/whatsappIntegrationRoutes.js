const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const { apiLimiter } = require('../middleware/rateLimit')
const whatsappIntegrationController = require('../controllers/whatsappIntegrationController')

router.use(auth)
router.use(supervisorOrAdmin)
router.use(apiLimiter)

router.get('/me', whatsappIntegrationController.getMe)
router.get('/debug-config', whatsappIntegrationController.debugConfig)
router.get('/debug-status', whatsappIntegrationController.debugStatus)
router.get('/status', whatsappIntegrationController.getStatus)
router.get('/operational-status', whatsappIntegrationController.getOperationalStatus)
router.get('/qrcode', whatsappIntegrationController.getQrCodeLegacy)
router.post('/restart', whatsappIntegrationController.restart)

router.get('/instances', whatsappIntegrationController.listInstances)
router.post('/instances', whatsappIntegrationController.createInstance)
router.patch('/instances/:id', whatsappIntegrationController.updateInstance)
router.post('/instances/:id/activate', whatsappIntegrationController.activateInstance)
router.post('/instances/:id/deactivate', whatsappIntegrationController.deactivateInstance)
router.post('/instances/:id/default', whatsappIntegrationController.setDefaultInstance)
router.get('/instances/:id/status', whatsappIntegrationController.getInstanceStatus)
router.get('/instances/:id/qrcode', whatsappIntegrationController.getInstanceQrCode)
router.post('/instances/:id/qrcode', whatsappIntegrationController.getInstanceQrCode)
router.post('/instances/:id/restart', whatsappIntegrationController.restartInstance)
router.post('/instances/:id/configure-webhooks', whatsappIntegrationController.configureInstanceWebhooks)

const connectRouter = express.Router()
connectRouter.get('/status', whatsappIntegrationController.getConnectStatus)
connectRouter.get('/qrcode', whatsappIntegrationController.getQrCode)
connectRouter.post('/qrcode', whatsappIntegrationController.getQrCode)
connectRouter.post('/restart', whatsappIntegrationController.connectRestart)
connectRouter.post('/phone-code', whatsappIntegrationController.phoneCode)
router.use('/connect', connectRouter)

router.post('/configure-webhooks', whatsappIntegrationController.configureWebhooks)
router.post('/contacts/sync', whatsappIntegrationController.syncContacts)
router.post('/groups/sync', whatsappIntegrationController.syncGroups)
router.post('/sync-all', whatsappIntegrationController.syncAll)

// Rotas para mensagens enviadas via UltraMsg
router.get('/messages', whatsappIntegrationController.getMessages)
router.get('/messages/statistics', whatsappIntegrationController.getMessagesStatistics)

module.exports = router
