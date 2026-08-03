const express = require('express')
const auth = require('../middleware/auth')
const requireCrmHabilitado = require('../middleware/requireCrmHabilitado')
const c = require('../controllers/crmController')
const crmSso = require('../controllers/crmSsoController')

const router = express.Router()

/** Autenticação + empresa com CRM ativo (admin pode desligar em Configurações). */
const authCrm = [auth, requireCrmHabilitado]

router.get('/google/callback', c.googleCallback)

// Hand-off (SSO) para o CRM Avançado. Só exige autenticação do ZapERP —
// a presença de CRM_AVANCADO_URL/ZAP_SSO_SECRET é o interruptor mestre.
router.get('/abrir-avancado', auth, crmSso.abrirCrmAvancado)

router.get('/pipelines', ...authCrm, c.listPipelines)
router.post('/pipelines', ...authCrm, c.createPipeline)
router.get('/pipelines/:id/full', ...authCrm, c.getPipelineFull)
router.post('/pipelines/:id/clone', ...authCrm, c.clonePipeline)
router.patch('/pipelines/:id/padrao', ...authCrm, c.setPipelinePadrao)
router.get('/pipelines/:id', ...authCrm, c.getPipeline)
router.put('/pipelines/:id', ...authCrm, c.updatePipeline)
router.delete('/pipelines/:id', ...authCrm, c.deletePipeline)

router.get('/stages', ...authCrm, c.listStages)
router.post('/stages', ...authCrm, c.createStage)
router.put('/stages/:id', ...authCrm, c.updateStage)
router.delete('/stages/:id', ...authCrm, c.deleteStage)

router.get('/origens', ...authCrm, c.listOrigens)
router.post('/origens', ...authCrm, c.createOrigem)
router.put('/origens/:id', ...authCrm, c.updateOrigem)

router.get('/campaigns', ...authCrm, c.listCampaigns)
router.post('/campaigns', ...authCrm, c.createCampaign)
router.put('/campaigns/:id', ...authCrm, c.updateCampaign)
router.get('/campanhas', ...authCrm, c.listCampaigns)
router.post('/campanhas', ...authCrm, c.createCampaign)
router.put('/campanhas/:id', ...authCrm, c.updateCampaign)

router.get('/tags', ...authCrm, c.listTags)
router.post('/tags', ...authCrm, c.createTag)
router.put('/tags/:id', ...authCrm, c.updateTag)

router.get('/lost-reasons', ...authCrm, c.listLostReasons)
router.post('/lost-reasons', ...authCrm, c.createLostReason)
router.put('/lost-reasons/:id', ...authCrm, c.updateLostReason)
router.get('/loss-reasons', ...authCrm, c.listLostReasons)
router.post('/loss-reasons', ...authCrm, c.createLostReason)
router.put('/loss-reasons/:id', ...authCrm, c.updateLostReason)

router.post('/leads/reorder', ...authCrm, c.reorderLeads)
router.get('/leads/export', ...authCrm, c.exportLeadsCsv)
router.post('/leads/from-conversa/:conversaId', ...authCrm, c.createLeadFromConversa)
router.post('/leads/from-cliente/:clienteId', ...authCrm, c.createLeadFromCliente)
router.get('/leads', ...authCrm, c.listLeads)
router.post('/leads', ...authCrm, c.createLead)
router.get('/leads/:id', ...authCrm, c.getLead)
router.patch('/leads/:id', ...authCrm, c.updateLead)
router.post('/leads/:id/move', ...authCrm, c.moveLead)
router.post('/leads/:id/win', ...authCrm, c.winLead)
router.post('/leads/:id/lose', ...authCrm, c.loseLead)
router.post('/leads/:id/reopen', ...authCrm, c.reopenLead)
router.post('/leads/:id/transfer', ...authCrm, c.transferLead)
router.post('/leads/:id/contact', ...authCrm, c.registerContact)
router.get('/leads/:id/timeline', ...authCrm, c.getLeadTimeline)
router.get('/leads/:id/history', ...authCrm, c.getLeadHistory)

router.get('/leads/:id/notes', ...authCrm, c.listNotas)
router.post('/leads/:id/notes', ...authCrm, c.createNota)
router.put('/leads/:id/notas/:notaId', ...authCrm, c.updateNota)
router.delete('/leads/:id/notas/:notaId', ...authCrm, c.deleteNota)

router.get('/leads/:id/activities', ...authCrm, c.listAtividades)
router.post('/leads/:id/activities', ...authCrm, c.createAtividade)
router.patch('/activities/:activityId', ...authCrm, c.updateAtividade)
router.put('/activities/:activityId', ...authCrm, c.updateAtividade)
router.patch('/activities/:activityId/status', ...authCrm, c.patchAtividadeStatus)
router.delete('/activities/:activityId', ...authCrm, c.deleteAtividade)

router.get('/kanban', ...authCrm, c.getKanban)

router.get('/agenda/resumo', ...authCrm, c.getAgendaResumo)
router.get('/agenda', ...authCrm, c.getAgenda)

router.get('/dashboard/funnel', ...authCrm, c.getDashboardFunnel)
router.get('/dashboard/responsaveis', ...authCrm, c.getDashboardResponsaveis)
router.get('/dashboard/origens', ...authCrm, c.getDashboardOrigens)
router.get('/dashboard', ...authCrm, c.getDashboard)

router.get('/google/connect', ...authCrm, c.googleConnect)
router.get('/google/status', ...authCrm, c.googleStatus)
router.post('/google/disconnect', ...authCrm, c.googleDisconnect)
router.get('/google/calendars', ...authCrm, c.googleCalendars)
router.post('/google/calendar', ...authCrm, c.putGoogleCalendar)
router.post('/google/sync/:leadId', ...authCrm, c.googleSyncLead)

module.exports = router
