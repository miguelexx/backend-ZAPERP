const express = require('express')
const router = express.Router()
const authBearerOrQuery = require('../middleware/authBearerOrQuery')
const mediaProxyController = require('../controllers/mediaProxyController')

router.get('/proxy', authBearerOrQuery, mediaProxyController.proxyMedia)

module.exports = router
