const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const configController = require('../controllers/configController')

router.use(auth)
router.use(adminOnly)

router.get('/empresa', configController.getEmpresa)
router.put('/empresa', configController.putEmpresa)
router.get('/planos', configController.getPlanos)
router.get('/auditoria', configController.getAuditoria)
router.get('/empresas-whatsapp', configController.getEmpresasWhatsapp)
router.post('/empresas-whatsapp', configController.postEmpresasWhatsapp)
router.delete('/empresas-whatsapp/:id', configController.deleteEmpresasWhatsapp)

module.exports = router
