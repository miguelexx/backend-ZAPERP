const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const minhasPendenciasController = require('../controllers/minhasPendenciasController')

// GET /conversas/minhas-pendencias — contadores do atendente logado
// GET /conversas/minhas-pendencias?categoria=transferidosParaVoce|aguardandoSuaResposta|emAtraso — ids da categoria
router.get('/minhas-pendencias', auth, minhasPendenciasController.obterMinhasPendencias)

module.exports = router
