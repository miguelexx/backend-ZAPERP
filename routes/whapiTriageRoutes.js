/**
 * Rotas da Triagem Interativa Whapi. Montadas em /whapi/triagem e /api/whapi/triagem.
 * Leitura: supervisor/admin (auth). Escrita: admin (espelha /chatbot e /labels).
 * Só empresas com instância Whapi (o controller responde 501 caso contrário).
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const ctrl = require('../controllers/whapiTriageController')

router.get('/instances', auth, ctrl.listarInstancias)
router.get('/config', auth, ctrl.getConfig)
router.put('/config', auth, adminOnly, ctrl.saveConfig)

module.exports = router
