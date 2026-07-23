const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const adminOnly = require('../middleware/adminOnly')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const { destructiveLimiter } = require('../middleware/rateLimit')
const configController = require('../controllers/configController')
const permissoesController = require('../controllers/permissoesController')
const configOperacionalRoutes = require('./configOperacionalRoutes')
const atendimentoLimitsRoutes = require('./atendimentoLimitsRoutes')
const { uploadLogo } = require('../middleware/upload')

// Configurações: supervisor e admin (atendente não acessa)
router.use(auth)

// Dados basicos da empresa alimentam a marca/cabecalho do atendimento.
// Atendentes podem ler; alteracoes continuam restritas abaixo.
router.get('/empresa', configController.getEmpresa)

router.use(supervisorOrAdmin)

// Config operacional e auditoria de eventos (proteção WhatsApp)
router.use('/', configOperacionalRoutes)
router.use('/atendimento-limits', atendimentoLimitsRoutes)

router.put('/empresa', configController.putEmpresa)
router.post('/empresa/logo', adminOnly, uploadLogo.single('logo'), configController.uploadLogoEmpresa)
router.delete('/empresa/logo', adminOnly, destructiveLimiter, configController.deleteLogoEmpresa)
router.get('/planos', configController.getPlanos)
router.get('/webhook-logs', configController.getWebhookLogs)
router.get('/webhook-logs/:id', configController.getWebhookLogDetail)
router.get('/auditoria', configController.getAuditoria)
router.get('/empresas-whatsapp', configController.getEmpresasWhatsapp)
router.post('/empresas-whatsapp', configController.postEmpresasWhatsapp)
router.delete('/empresas-whatsapp/:id', destructiveLimiter, configController.deleteEmpresasWhatsapp)

// Perfil do WhatsApp — alteram dados da instância Z-API conectada (apenas admin)
router.put('/whatsapp/profile-picture',    adminOnly, destructiveLimiter, configController.updateWhatsappProfilePicture)
router.put('/whatsapp/profile-name',       adminOnly, destructiveLimiter, configController.updateWhatsappProfileName)
router.put('/whatsapp/profile-description', adminOnly, destructiveLimiter, configController.updateWhatsappProfileDescription)

// Permissões granulares — catálogo (para página de configuração de permissões)
router.get('/permissoes/catalogo', permissoesController.getCatalogo)

module.exports = router
