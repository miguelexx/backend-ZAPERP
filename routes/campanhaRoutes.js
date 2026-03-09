const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const campanhaController = require('../controllers/campanhaController')

router.get('/', auth, campanhaController.listar)
router.get('/:id', auth, campanhaController.obter)
router.post('/', auth, campanhaController.criar)
router.put('/:id', auth, campanhaController.atualizar)
router.delete('/:id', auth, campanhaController.excluir)
router.post('/:id/pausar', auth, campanhaController.pausar)
router.post('/:id/retomar', auth, campanhaController.retomar)
router.get('/:id/envios', auth, campanhaController.listarEnvios)

module.exports = router
