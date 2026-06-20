const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const iaController = require('../controllers/iaController')

// Chatbot/IA: supervisor e admin (atendente não acessa)
router.get('/config', auth, supervisorOrAdmin, iaController.getConfig)
router.put('/config', auth, supervisorOrAdmin, iaController.putConfig)
router.get('/regras', auth, supervisorOrAdmin, iaController.getRegras)
router.post('/regras', auth, supervisorOrAdmin, iaController.postRegra)
router.put('/regras/:id', auth, supervisorOrAdmin, iaController.putRegra)
router.delete('/regras/:id', auth, supervisorOrAdmin, iaController.deleteRegra)
router.get('/logs', auth, supervisorOrAdmin, iaController.getLogs)

module.exports = router
