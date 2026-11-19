const express = require('express')
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const rankingController = require('../controllers/rankingController')

const router = express.Router()

// Qualquer usuário autenticado vê o ranking da PRÓPRIA empresa (company_id do JWT).
router.get('/atual', auth, rankingController.atual)
// Configuração e histórico: só administrador (mesmo middleware das demais telas de admin).
router.get('/config', auth, adminOnly, rankingController.obterConfig)
router.put('/config', auth, adminOnly, rankingController.salvarConfig)
router.get('/historico', auth, adminOnly, rankingController.historico)

module.exports = router
