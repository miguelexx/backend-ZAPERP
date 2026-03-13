const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const configController = require('../controllers/configController')
const permissoesController = require('../controllers/permissoesController')
const configOperacionalRoutes = require('./configOperacionalRoutes')

// Configurações: supervisor e admin (atendente não acessa)
router.use(auth)
router.use(supervisorOrAdmin)

// Config operacional e auditoria de eventos (proteção WhatsApp)
router.use('/', configOperacionalRoutes)

router.get('/empresa', configController.getEmpresa)
router.put('/empresa', configController.putEmpresa)
router.get('/planos', configController.getPlanos)
router.get('/webhook-logs', configController.getWebhookLogs)
router.get('/webhook-logs/:id', configController.getWebhookLogDetail)
router.get('/auditoria', configController.getAuditoria)
router.get('/empresas-whatsapp', configController.getEmpresasWhatsapp)
router.post('/empresas-whatsapp', configController.postEmpresasWhatsapp)
router.delete('/empresas-whatsapp/:id', configController.deleteEmpresasWhatsapp)

// Perfil do WhatsApp — alteram dados da instância Z-API conectada (apenas admin)
router.put('/whatsapp/profile-picture',    configController.updateWhatsappProfilePicture)
router.put('/whatsapp/profile-name',       configController.updateWhatsappProfileName)
router.put('/whatsapp/profile-description', configController.updateWhatsappProfileDescription)

// Permissões granulares — catálogo (para página de configuração de permissões)
router.get('/permissoes/catalogo', permissoesController.getCatalogo)

module.exports = router
