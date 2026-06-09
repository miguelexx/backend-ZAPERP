/**
 * Rotas de operacional: config operacional e auditoria eventos.
 * Jobs operacionais estão em jobsRoutes (auth).
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const configOperacionalController = require('../controllers/configOperacionalController')
const atendimentoSemRespostaController = require('../controllers/atendimentoSemRespostaController')

router.use(auth)
router.use(supervisorOrAdmin)

/** GET /config/operacional */
router.get('/operacional', configOperacionalController.getOperacional)
/** PUT /config/operacional */
router.put('/operacional', configOperacionalController.putOperacional)
/** GET /config/auditoria-eventos */
router.get('/auditoria-eventos', configOperacionalController.getAuditoriaEventos)

/** Alertas de atendimento sem resposta */
router.get('/alerta-sem-resposta', atendimentoSemRespostaController.getConfig)
router.put('/alerta-sem-resposta', atendimentoSemRespostaController.putConfig)
router.get('/alerta-sem-resposta/eventos', atendimentoSemRespostaController.getEventos)
router.post('/alerta-sem-resposta/processar', atendimentoSemRespostaController.processar)

module.exports = router
