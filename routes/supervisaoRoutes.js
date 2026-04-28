const express = require('express')
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const supervisaoController = require('../controllers/supervisaoController')

const router = express.Router()

router.get('/resumo', auth, supervisorOrAdmin, supervisaoController.resumo)
router.get('/clientes-pendentes', auth, supervisorOrAdmin, supervisaoController.clientesPendentes)
router.get('/funcionarios/:usuarioId/movimentacao', auth, supervisorOrAdmin, supervisaoController.movimentacaoFuncionario)
router.get('/relatorio-diario', auth, supervisorOrAdmin, supervisaoController.relatorioDiarioGestor)

module.exports = router
