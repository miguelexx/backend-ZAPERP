const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const printController = require('../controllers/printController')

// Base: /print — também montado em /api/print (app.js)
router.get('/conversas/:conversaId', auth, printController.imprimirConversa)

module.exports = router
