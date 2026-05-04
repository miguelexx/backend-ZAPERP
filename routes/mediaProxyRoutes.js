const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const mediaProxyController = require('../controllers/mediaProxyController')

router.get('/proxy', auth, mediaProxyController.proxyMedia)

module.exports = router
