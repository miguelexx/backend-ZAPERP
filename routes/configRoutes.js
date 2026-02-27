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

// Perfil do WhatsApp — alteram dados da instância Z-API conectada (apenas admin)
router.put('/whatsapp/profile-picture',    configController.updateWhatsappProfilePicture)
router.put('/whatsapp/profile-name',       configController.updateWhatsappProfileName)
router.put('/whatsapp/profile-description', configController.updateWhatsappProfileDescription)

module.exports = router
