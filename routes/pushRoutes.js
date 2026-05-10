const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const fcmPushTokenController = require('../controllers/fcmPushTokenController')

router.post('/tokens', auth, fcmPushTokenController.upsertToken)
router.post('/tokens/logout', auth, fcmPushTokenController.logoutToken)
router.delete('/tokens/logout', auth, fcmPushTokenController.logoutToken)
/** Compat: alguns clientes usam DELETE /tokens (body pode falhar em proxies — preferir POST …/logout) */
router.delete('/tokens', auth, fcmPushTokenController.logoutToken)

module.exports = router
