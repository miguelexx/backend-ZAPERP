const express = require('express')
const auth = require('../middleware/auth')
const c = require('../controllers/crmController')

const router = express.Router()

router.get('/google/callback', c.googleCallback)

router.get('/pipelines', auth, c.listPipelines)
router.post('/pipelines', auth, c.createPipeline)
router.get('/pipelines/:id/full', auth, c.getPipelineFull)
router.post('/pipelines/:id/clone', auth, c.clonePipeline)
router.patch('/pipelines/:id/padrao', auth, c.setPipelinePadrao)
router.get('/pipelines/:id', auth, c.getPipeline)
router.put('/pipelines/:id', auth, c.updatePipeline)
router.delete('/pipelines/:id', auth, c.deletePipeline)

router.get('/stages', auth, c.listStages)
router.post('/stages', auth, c.createStage)
router.put('/stages/:id', auth, c.updateStage)
router.delete('/stages/:id', auth, c.deleteStage)

router.get('/origens', auth, c.listOrigens)
router.post('/origens', auth, c.createOrigem)
router.put('/origens/:id', auth, c.updateOrigem)

router.get('/lost-reasons', auth, c.listLostReasons)

router.post('/leads/reorder', auth, c.reorderLeads)
router.get('/leads/export', auth, c.exportLeadsCsv)
router.post('/leads/from-conversa/:conversaId', auth, c.createLeadFromConversa)
router.post('/leads/from-cliente/:clienteId', auth, c.createLeadFromCliente)
router.get('/leads', auth, c.listLeads)
router.post('/leads', auth, c.createLead)
router.get('/leads/:id', auth, c.getLead)
router.patch('/leads/:id', auth, c.updateLead)
router.post('/leads/:id/move', auth, c.moveLead)
router.get('/leads/:id/history', auth, c.getLeadHistory)

router.get('/leads/:id/notes', auth, c.listNotas)
router.post('/leads/:id/notes', auth, c.createNota)
router.put('/leads/:id/notas/:notaId', auth, c.updateNota)
router.delete('/leads/:id/notas/:notaId', auth, c.deleteNota)

router.get('/leads/:id/activities', auth, c.listAtividades)
router.post('/leads/:id/activities', auth, c.createAtividade)
router.patch('/activities/:activityId', auth, c.updateAtividade)
router.put('/activities/:activityId', auth, c.updateAtividade)
router.patch('/activities/:activityId/status', auth, c.patchAtividadeStatus)
router.delete('/activities/:activityId', auth, c.deleteAtividade)

router.get('/kanban', auth, c.getKanban)

router.get('/agenda/resumo', auth, c.getAgendaResumo)
router.get('/agenda', auth, c.getAgenda)

router.get('/dashboard/funnel', auth, c.getDashboardFunnel)
router.get('/dashboard/responsaveis', auth, c.getDashboardResponsaveis)
router.get('/dashboard/origens', auth, c.getDashboardOrigens)
router.get('/dashboard', auth, c.getDashboard)

router.get('/google/connect', auth, c.googleConnect)
router.get('/google/status', auth, c.googleStatus)
router.post('/google/disconnect', auth, c.googleDisconnect)
router.get('/google/calendars', auth, c.googleCalendars)
router.post('/google/calendar', auth, c.putGoogleCalendar)
router.post('/google/sync/:leadId', auth, c.googleSyncLead)

module.exports = router
