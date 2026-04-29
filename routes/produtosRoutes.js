const express = require('express')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const produtosController = require('../controllers/produtosController')

const router = express.Router()

router.use(auth)

router.get('/consulta', produtosController.consulta)
router.get('/sync/status', produtosController.syncStatus)
router.post('/sync/wm', adminOnly, produtosController.syncWm)

module.exports = router
