const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const supervisorOrAdmin = require('../middleware/supervisorOrAdmin')
const jobsController = require('../controllers/jobsController')
const { enqueue, listJobs, retryJob, pauseAll, resumeAll, JOB_TIPOS } = require('../services/queueManager')

router.post('/timeout-inatividade', jobsController.checkCronSecret, jobsController.timeoutInatividade)
router.post('/timeout-inatividade-chatbot', jobsController.checkCronSecret, jobsController.timeoutInatividadeChatbot)
router.post('/finalizacao-ausencia-cliente', jobsController.checkCronSecret, jobsController.finalizacaoAusenciaCliente)

// Operacional: requer auth + supervisor/admin
const operacionalRouter = express.Router()
operacionalRouter.use(auth)
operacionalRouter.use(supervisorOrAdmin)

operacionalRouter.get('/', async (req, res) => {
  try {
    const { company_id } = req.user
    const { status } = req.query
    const result = await listJobs(company_id, { status })
    return res.json(result.ok ? { jobs: result.jobs } : { jobs: [], error: result.error })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao listar jobs' })
  }
})

operacionalRouter.post('/sync-contatos', async (req, res) => {
  try {
    const { company_id } = req.user
    const result = await enqueue(company_id, JOB_TIPOS.SYNC_CONTATOS, req.body || {})
    if (!result.ok) return res.status(400).json({ error: result.error })
    return res.json({ ok: true, job_id: result.job_id })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao enfileirar' })
  }
})

operacionalRouter.post('/sync-fotos', async (req, res) => {
  try {
    const { company_id } = req.user
    const result = await enqueue(company_id, JOB_TIPOS.SYNC_FOTOS, req.body || {})
    if (!result.ok) return res.status(400).json({ error: result.error })
    return res.json({ ok: true, job_id: result.job_id })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao enfileirar' })
  }
})

operacionalRouter.post('/pause-all', async (req, res) => {
  try {
    const { company_id } = req.user
    await pauseAll(company_id)
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao pausar' })
  }
})

operacionalRouter.post('/resume-all', async (req, res) => {
  try {
    const { company_id } = req.user
    await resumeAll(company_id)
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao retomar' })
  }
})

operacionalRouter.post('/:id/retry', async (req, res) => {
  try {
    const { company_id } = req.user
    const jobId = parseInt(req.params.id, 10)
    const result = await retryJob(jobId, company_id)
    if (!result.ok) return res.status(400).json({ error: result.error })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao retentar' })
  }
})

router.use(operacionalRouter)

module.exports = router
