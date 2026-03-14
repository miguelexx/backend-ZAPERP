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

const connectRouter = express.Router()
connectRouter.get('/status', whatsappIntegrationController.getConnectStatus)
connectRouter.get('/qrcode', whatsappIntegrationController.getQrCode)
connectRouter.post('/qrcode', whatsappIntegrationController.getQrCode)
connectRouter.post('/restart', whatsappIntegrationController.connectRestart)
connectRouter.post('/phone-code', whatsappIntegrationController.phoneCode)
router.use('/connect', connectRouter)

router.post('/contacts/sync', whatsappIntegrationController.syncContacts)
router.post('/groups/sync', whatsappIntegrationController.syncGroups)

module.exports = router
