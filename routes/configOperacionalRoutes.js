/**
 * Rotas de operacional: config operacional e auditoria eventos.
 * Jobs operacionais estão em jobsRoutes (auth).
 */

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const configOperacionalController = require('../controllers/configOperacionalController')

router.use(auth)
router.use(supervisorOrAdmin)

/** GET /config/operacional */
router.get('/operacional', configOperacionalController.getOperacional)
/** PUT /config/operacional */
router.put('/operacional', configOperacionalController.putOperacional)
/** GET /config/auditoria-eventos */
router.get('/auditoria-eventos', configOperacionalController.getAuditoriaEventos)

module.exports = router
