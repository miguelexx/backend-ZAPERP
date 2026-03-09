const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const campanhaController = require('../controllers/campanhaController')

router.get('/', auth, supervisorOrAdmin, campanhaController.listar)
router.get('/:id', auth, supervisorOrAdmin, campanhaController.obter)
router.post('/', auth, supervisorOrAdmin, campanhaController.criar)
router.put('/:id', auth, supervisorOrAdmin, campanhaController.atualizar)
router.delete('/:id', auth, supervisorOrAdmin, campanhaController.excluir)
router.post('/:id/pausar', auth, supervisorOrAdmin, campanhaController.pausar)
router.post('/:id/retomar', auth, supervisorOrAdmin, campanhaController.retomar)
router.get('/:id/envios', auth, supervisorOrAdmin, campanhaController.listarEnvios)

module.exports = router
