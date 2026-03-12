/**
 * Gerenciador de fila de jobs (tabela jobs no PostgreSQL).
 * Enfileira, processa, retry com backoff.
 */

const supabase = require('../config/supabase')
const { getConfig, updateConfig, isProcessamentoPausado } = require('./configOperacionalService')
const { canRunJob, recordJobStart, recordJobEnd } = require('./operationalRateLimiter')
const { registrarEvento, TIPOS } = require('./operationalAuditService')
const { syncContactsFullProgressiva } = require('./syncProgressivaService')

const JOB_TIPOS = {
  SYNC_CONTATOS: 'sync_contatos',
  SYNC_FOTOS: 'sync_fotos'
}

const MAX_CONCURRENT = parseInt(process.env.QUEUE_MAX_CONCURRENT_JOBS, 10) || 2
const BACKOFF_BASE_MS = parseInt(process.env.QUEUE_BACKOFF_BASE_MS, 10) || 5000

let runningCount = 0

/**
 * Verifica se já existe job igual (tipo+company_id) em pending ou running.
 */
async function jobDuplicado(company_id, tipo) {
  const { data } = await supabase
    .from('jobs')
    .select('id')
    .eq('company_id', company_id)
    .eq('tipo', tipo)
    .in('status', ['pending', 'running'])
    .limit(1)
  return data && data.length > 0
}

/**
 * Enfileira um job.
 * @param {number} company_id
 * @param {string} tipo - sync_contatos, sync_fotos
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, job_id?: number, error?: string }>}
 */
async function enqueue(company_id, tipo, payload = {}) {
  if (!company_id || !tipo) return { ok: false, error: 'company_id e tipo obrigatórios' }

  const dup = await jobDuplicado(company_id, tipo)
  if (dup) return { ok: false, error: 'Job já enfileirado ou em execução' }

  const config = await getConfig(company_id)
  const maxTentativas = config.retry_max ?? 3

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      company_id,
      tipo,
      payload: payload || {},
      status: 'pending',
      tentativas: 0,
      max_tentativas: maxTentativas,
      next_run_at: new Date().toISOString()
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  await registrarEvento(company_id, TIPOS.JOB_ENFILEIRADO, `Job ${tipo} enfileirado`, { job_id: data?.id })
  return { ok: true, job_id: data?.id }
}

/**
 * Lista jobs por empresa.
 * @param {number} company_id
 * @param {object} opts - { status, limit }
 */
async function listJobs(company_id, opts = {}) {
  const limit = Math.min(100, opts.limit || 50)
  let q = supabase.from('jobs').select('*').eq('company_id', company_id).order('criado_em', { ascending: false }).limit(limit)
  if (opts.status) q = q.eq('status', opts.status)
  const { data, error } = await q
  if (error) return { ok: false, jobs: [] }
  return { ok: true, jobs: data || [] }
}

/**
 * Obtém próximo job pendente (respeitando concorrência e processamento_pausado).
 */
async function getNextPendingJob() {
  if (runningCount >= MAX_CONCURRENT) return null

  const { data } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .or('next_run_at.is.null,next_run_at.lte.' + new Date().toISOString())
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data?.id) return null

  const pausado = await isProcessamentoPausado(data.company_id)
  if (pausado) return null

  const { error } = await supabase
    .from('jobs')
    .update({ status: 'running', tentativas: data.tentativas + 1, atualizado_em: new Date().toISOString() })
    .eq('id', data.id)
    .eq('status', 'pending')

  if (error) return null
  return { ...data, tentativas: data.tentativas + 1 }
}

/**
 * Handler por tipo de job.
 */
async function executeJob(job) {
  const { id, company_id, tipo, payload } = job

  try {
    if (tipo === JOB_TIPOS.SYNC_CONTATOS) {
      const result = await syncContactsFullProgressiva(company_id, {
        ...payload,
        includeConversationCache: payload?.includeConversationCache !== false
      })
      return { ok: true, resultado: result }
    }

    if (tipo === JOB_TIPOS.SYNC_FOTOS) {
      const { syncFotosFullProgressiva } = require('./syncFotosProgressivaService')
      const result = await syncFotosFullProgressiva(company_id, payload)
      return { ok: true, resultado: result }
    }

    return { ok: false, erro: `Tipo desconhecido: ${tipo}` }
  } catch (e) {
    return { ok: false, erro: e?.message || String(e) }
  }
}

/**
 * Marca job como concluído ou falho.
 */
async function finalizeJob(jobId, success, job, resultado, erro) {
  const tentativas = job?.tentativas || 1
  const maxTentativas = job?.max_tentativas || 3
  const esgotouTentativas = tentativas >= maxTentativas

  let status, nextRunAt

  if (success) {
    status = 'completed'
    nextRunAt = null
  } else if (esgotouTentativas) {
    status = 'dead_letter'
    nextRunAt = null
  } else {
    status = 'pending'
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, tentativas)
    nextRunAt = new Date(Date.now() + backoffMs).toISOString()
  }

  const update = {
    status,
    resultado_json: success ? (resultado?.resultado || resultado) : null,
    erro: success ? null : (erro || 'Erro desconhecido'),
    next_run_at: nextRunAt,
    atualizado_em: new Date().toISOString()
  }

  await supabase.from('jobs').update(update).eq('id', jobId)
}

/**
 * Processa um job (chamado pelo worker).
 */
async function processJob(job, io = null) {
  runningCount++
  recordJobStart(job.company_id)
  try {
    const result = await executeJob(job)
    if (result.ok) {
      await finalizeJob(job.id, true, job, result)
      await registrarEvento(job.company_id, TIPOS.JOB_CONCLUIDO, `Job ${job.tipo} concluído`, { job_id: job.id })
      if (io && job.tipo === JOB_TIPOS.SYNC_CONTATOS && result.resultado) {
        const r = result.resultado
        io.to(`empresa_${job.company_id}`).emit('zapi_sync_contatos', {
          ok: true,
          total_contatos: r.totalProcessados || 0,
          criados: r.totalCriados || 0,
          atualizados: r.totalAtualizados || 0,
          fotos_atualizadas: 0
        })
      }
      if (io && job.tipo === JOB_TIPOS.SYNC_FOTOS && result.resultado) {
        io.to(`empresa_${job.company_id}`).emit('zapi_sync_contatos', {
          ok: true,
          total_contatos: 0,
          criados: 0,
          atualizados: result.resultado.totalAtualizados || 0,
          fotos_atualizadas: result.resultado.totalAtualizados || 0
        })
      }
      return
    }

    await finalizeJob(job.id, false, job, result, result.erro)
    await registrarEvento(job.company_id, TIPOS.JOB_FALHOU, `Job ${job.tipo} falhou`, { job_id: job.id, erro: result.erro })

    if (job.tentativas >= job.max_tentativas) {
      const { updateConfig } = require('./configOperacionalService')
      await updateConfig(job.company_id, { processamento_pausado: true })
      await registrarEvento(job.company_id, TIPOS.PAUSA, 'Pausa automática após falhas repetidas', { job_id: job.id })
    }
  } finally {
    recordJobEnd(job.company_id)
    runningCount--
  }
}

/**
 * Inicia polling do worker.
 * @param {number} intervalMs - intervalo entre verificações
 * @param {object} io - Socket.IO para emitir zapi_sync_contatos ao concluir
 */
function startWorker(intervalMs = 5000, io = null) {
  const poll = async () => {
    try {
      const job = await getNextPendingJob()
      if (job) {
        const rateOk = await canRunJob(job.company_id)
        if (rateOk.ok) {
          processJob(job, io)
        } else {
          await supabase.from('jobs').update({
            status: 'pending',
            tentativas: Math.max(0, (job.tentativas || 1) - 1)
          }).eq('id', job.id)
        }
      }
    } catch (e) {
      console.warn('[queueManager] Erro no worker:', e?.message || e)
    }
    setTimeout(poll, intervalMs)
  }
  poll()
}

/**
 * Retry de job failed/dead_letter.
 */
async function retryJob(jobId, company_id) {
  const { data } = await supabase.from('jobs').select('*').eq('id', jobId).eq('company_id', company_id).maybeSingle()
  if (!data) return { ok: false, error: 'Job não encontrado' }
  if (!['failed', 'dead_letter'].includes(data.status)) return { ok: false, error: 'Job não está em estado retryável' }

  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'pending',
      tentativas: 0,
      next_run_at: new Date().toISOString(),
      erro: null,
      atualizado_em: new Date().toISOString()
    })
    .eq('id', jobId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Pausa todos os processamentos da empresa (via config).
 */
async function pauseAll(company_id) {
  return updateConfig(company_id, { processamento_pausado: true })
}

/**
 * Retoma processamento.
 */
async function resumeAll(company_id) {
  return updateConfig(company_id, { processamento_pausado: false })
}

module.exports = {
  enqueue,
  listJobs,
  getNextPendingJob,
  processJob,
  startWorker,
  retryJob,
  pauseAll,
  resumeAll,
  JOB_TIPOS
}
