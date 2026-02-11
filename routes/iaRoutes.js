const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const iaController = require('../controllers/iaController')

router.get('/config', auth, iaController.getConfig)
router.put('/config', auth, iaController.putConfig)
router.get('/regras', auth, iaController.getRegras)
router.post('/regras', auth, iaController.postRegra)
router.put('/regras/:id', auth, iaController.putRegra)
router.delete('/regras/:id', auth, iaController.deleteRegra)
router.get('/logs', auth, iaController.getLogs)

module.exports = router
