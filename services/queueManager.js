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
  SYNC_FOTOS: 'sync_fotos',
  SYNC_MENSAGENS_ANTIGAS: 'sync_mensagens_antigas'
}

const ACTIVE_JOB_STATUSES = ['pending', 'running', 'cancel_requested']

const MAX_CONCURRENT = parseInt(process.env.QUEUE_MAX_CONCURRENT_JOBS, 10) || 2
const BACKOFF_BASE_MS = parseInt(process.env.QUEUE_BACKOFF_BASE_MS, 10) || 5000

let runningCount = 0
const activeLocalJobs = new Set()
const enqueueInFlight = new Map()

/**
 * Verifica se já existe job igual (tipo+company_id) em pending ou running.
 */
async function jobDuplicado(company_id, tipo) {
  const { data } = await supabase
    .from('jobs')
    .select('id')
    .eq('company_id', company_id)
    .eq('tipo', tipo)
    .in('status', ACTIVE_JOB_STATUSES)
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
  const key = `${company_id}:${tipo}`
  if (enqueueInFlight.has(key)) return enqueueInFlight.get(key)
  const pending = enqueueOnce(company_id, tipo, payload)
  enqueueInFlight.set(key, pending)
  try { return await pending } finally { enqueueInFlight.delete(key) }
}

async function enqueueOnce(company_id, tipo, payload = {}) {
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

async function getActiveJob(company_id, tipo) {
  if (!company_id || !tipo) return null
  const { data } = await supabase
    .from('jobs')
    .select('*')
    .eq('company_id', Number(company_id))
    .eq('tipo', tipo)
    .in('status', ACTIVE_JOB_STATUSES)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

async function isJobCancelRequested(company_id, jobId) {
  if (!jobId) return false
  const { data } = await supabase
    .from('jobs')
    .select('status')
    .eq('company_id', Number(company_id))
    .eq('id', Number(jobId))
    .maybeSingle()
  return data?.status === 'cancel_requested' || data?.status === 'cancelled'
}

/**
 * Obtém próximo job pendente (respeitando concorrência e processamento_pausado).
 */
async function getNextPendingJob() {
  if (runningCount >= MAX_CONCURRENT) return null

  const nowIso = new Date().toISOString()
  const { data } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .or('next_run_at.is.null,next_run_at.lte.' + nowIso)
    .order('criado_em', { ascending: true })
    .limit(100)

  let candidate = null
  for (const job of data || []) {
    if (job.tipo === JOB_TIPOS.SYNC_CONTATOS && job.payload?.manual === true || !(await isProcessamentoPausado(job.company_id))) {
      candidate = job
      break
    }
  }
  if (!candidate) return null
  return claimPendingJob(candidate)
}

async function claimPendingJob(data) {

  const nextTentativas = Number(data.tentativas || 0) + 1
  const update = {
    status: 'running',
    tentativas: nextTentativas,
    atualizado_em: new Date().toISOString()
  }

  const { data: locked, error } = await supabase
    .from('jobs')
    .update(update)
    .eq('id', data.id)
    .eq('company_id', data.company_id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (error || !locked?.id) return null
  return { ...data, ...update }
}

/**
 * Handler por tipo de job.
 */
async function executeJob(job, io = null) {
  const { id, company_id, tipo, payload } = job

  try {
    if (tipo === JOB_TIPOS.SYNC_CONTATOS) {
      const result = await syncContactsFullProgressiva(company_id, {
        ...payload,
        jobId: id,
        // Permite ao usuario PARAR a importacao no meio: o worker checa esta flag
        // a cada contato e encerra preservando o que ja foi importado.
        shouldCancel: () => isJobCancelRequested(company_id, id),
        onProgress: async (progress) => {
          if (!io) return
          const { contactSyncStatus } = require('../helpers/contactSyncStatus')
          io.to(`empresa_${company_id}`).emit('zapi_sync_contatos', contactSyncStatus(job, { ...progress, job_id: id }))
        },
        includeConversationCache: payload?.includeConversationCache !== false
      })
      // Cancelamento e sucesso (parada limpa), nao falha: mantem os contatos ja gravados.
      return { ok: result.ok === true || result.cancelled === true, resultado: result, erro: result.error }
    }

    if (tipo === JOB_TIPOS.SYNC_FOTOS) {
      const { syncFotosFullProgressiva } = require('./syncFotosProgressivaService')
      const result = await syncFotosFullProgressiva(company_id, payload)
      return { ok: true, resultado: result }
    }

    if (tipo === JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS) {
      const { syncOldMessagesForCompany } = require('./oldMessagesSyncService')
      const result = await syncOldMessagesForCompany(company_id, {
        ...payload,
        jobId: id,
        shouldCancel: () => isJobCancelRequested(company_id, id),
      })
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

  const cancelled = success && (resultado?.cancelled === true || resultado?.resultado?.cancelled === true)

  if (cancelled) {
    status = 'cancelled'
    nextRunAt = null
  } else if (success) {
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
    resultado_json: resultado?.resultado || (success ? resultado : null),
    erro: cancelled ? 'Cancelado pelo usuario' : (success ? null : (erro || 'Erro desconhecido')),
    next_run_at: nextRunAt,
    atualizado_em: new Date().toISOString()
  }

  let q = supabase.from('jobs').update(update).eq('id', jobId)
  if (job?.company_id != null) q = q.eq('company_id', job.company_id)
  await q
}

/**
 * Processa um job (chamado pelo worker).
 */
async function processJob(job, io = null) {
  runningCount++
  activeLocalJobs.add(job.id)
  const heartbeat = setInterval(() => {
    Promise.resolve(supabase.from('jobs').update({ atualizado_em: new Date().toISOString() })
      .eq('id', job.id).eq('company_id', job.company_id).eq('status', 'running')).catch(() => {})
  }, 30000)
  heartbeat.unref?.()
  recordJobStart(job.company_id)
  try {
    const result = await executeJob(job, io)
    if (result.ok) {
      await finalizeJob(job.id, true, job, result)
      await registrarEvento(job.company_id, TIPOS.JOB_CONCLUIDO, `Job ${job.tipo} concluído`, { job_id: job.id })
      if (io && job.tipo === JOB_TIPOS.SYNC_CONTATOS && result.resultado) {
        const { contactSyncStatus } = require('../helpers/contactSyncStatus')
        // Nome do evento é legado ("zapi_*"); payload é sync WhatsApp/UltraMSG. Não renomear sem dual-emit + rollout frontend (../docs/reference/ADR-LEGACY-NAMING.md).
        const finalStatus = result.resultado.cancelled === true ? 'cancelled' : 'completed'
        io.to(`empresa_${job.company_id}`).emit('zapi_sync_contatos', contactSyncStatus({ ...job, status: finalStatus, resultado_json: result.resultado }))
      }
      if (io && job.tipo === JOB_TIPOS.SYNC_FOTOS && result.resultado) {
        // Mesmo evento legado que SYNC_CONTATOS (ver comentário acima).
        io.to(`empresa_${job.company_id}`).emit('zapi_sync_contatos', {
          ok: true,
          tipo: JOB_TIPOS.SYNC_FOTOS,
          total_contatos: 0,
          criados: 0,
          atualizados: result.resultado.totalAtualizados || 0,
          fotos_atualizadas: result.resultado.totalAtualizados || 0
        })
      }
      if (io && job.tipo === JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS && result.resultado) {
        const r = result.resultado
        io.to(`empresa_${job.company_id}`).emit('whatsapp_sync_mensagens_antigas', {
          ok: r.ok !== false,
          job_id: job.id,
          cancelled: r.cancelled === true,
          error: r.cancelled === true ? null : (r.ok === false ? (r.error || 'Erro ao sincronizar mensagens antigas.') : null),
          message: r.cancelled === true ? 'Sincronizacao de mensagens antigas cancelada.' : null,
          messages_per_chat: r.messagesPerChat || 0,
          chats_processados: r.chatsProcessed || 0,
          conversas_criadas: r.conversationsCreated || 0,
          mensagens_lidas: r.messagesFetched || 0,
          mensagens_importadas: r.messagesInserted || 0,
          mensagens_ignoradas: r.messagesSkipped || 0,
          erros: Array.isArray(r.errors) ? r.errors.slice(0, 5) : []
        })
      }
      return
    }

    await finalizeJob(job.id, false, job, result, result.erro)
    await registrarEvento(job.company_id, TIPOS.JOB_FALHOU, `Job ${job.tipo} falhou`, { job_id: job.id, erro: result.erro })
    if (io && job.tipo === JOB_TIPOS.SYNC_CONTATOS) {
      const { contactSyncStatus } = require('../helpers/contactSyncStatus')
      io.to(`empresa_${job.company_id}`).emit('zapi_sync_contatos', contactSyncStatus({
        ...job, status: job.tentativas >= job.max_tentativas ? 'dead_letter' : 'pending',
        erro: result.erro, resultado_json: result.resultado,
      }))
    }

    if (job.tentativas >= job.max_tentativas && job.tipo !== JOB_TIPOS.SYNC_CONTATOS) {
      const { updateConfig } = require('./configOperacionalService')
      await updateConfig(job.company_id, { processamento_pausado: true })
      await registrarEvento(job.company_id, TIPOS.PAUSA, 'Pausa automática após falhas repetidas', { job_id: job.id })
    }
  } finally {
    clearInterval(heartbeat)
    activeLocalJobs.delete(job.id)
    recordJobEnd(job.company_id)
    runningCount--
  }
}

/**
 * Recupera jobs travados em 'running' (processo anterior encerrou abruptamente).
 * Reseta para 'pending' jobs com mais de STALE_JOB_TIMEOUT_MS sem atualização.
 */
async function recoverStaleRunningJobs(companyId = null) {
  const STALE_JOB_TIMEOUT_MS = parseInt(process.env.QUEUE_STALE_JOB_TIMEOUT_MS, 10) || 10 * 60 * 1000
  const staleBefore = new Date(Date.now() - STALE_JOB_TIMEOUT_MS).toISOString()
  try {
    let query = supabase
      .from('jobs')
      .select('id, company_id, tipo, status, tentativas')
      .in('status', ['running', 'cancel_requested'])
      .lt('atualizado_em', staleBefore)
    if (companyId != null) query = query.eq('company_id', Number(companyId))
    const { data: staleJobs } = await query
    if (!staleJobs || staleJobs.length === 0) return
    console.warn(`[queueManager] Recuperando ${staleJobs.length} job(s) travados`)
    for (const job of staleJobs) {
      if (activeLocalJobs.has(job.id)) continue
      if (job.tipo === JOB_TIPOS.SYNC_CONTATOS) {
        await supabase.from('sync_locks').delete().eq('company_id', job.company_id).eq('tipo', 'contact_sync')
      }
      const nextStatus = job.status === 'cancel_requested' ? 'cancelled' : 'pending'
      await supabase
        .from('jobs')
        .update({
          status: nextStatus,
          erro: nextStatus === 'cancelled' ? 'Cancelado pelo usuario' : null,
          next_run_at: nextStatus === 'pending' ? new Date().toISOString() : null,
          atualizado_em: new Date().toISOString()
        })
        .eq('id', job.id)
        .eq('company_id', job.company_id)
        .eq('status', job.status)
      console.warn(`[queueManager] Job ${job.id} (${job.tipo}) empresa ${job.company_id} ajustado para ${nextStatus}`)
    }
  } catch (e) {
    console.warn('[queueManager] Erro ao recuperar jobs travados:', e?.message || e)
  }
}

/**
 * Inicia polling do worker.
 * @param {number} intervalMs - intervalo entre verificações
 * @param {object} io - Socket.IO para emitir evento legado `zapi_sync_contatos` ao concluir (ver ../docs/reference/ADR-LEGACY-NAMING.md)
 */
function startWorker(intervalMs = 5000, io = null) {
  // Recupera jobs travados de crashes anteriores antes de iniciar o polling
  recoverStaleRunningJobs().catch(() => {})
  let lastRecovery = Date.now()

  const poll = async () => {
    try {
      if (Date.now() - lastRecovery >= 60000) {
        lastRecovery = Date.now()
        await recoverStaleRunningJobs()
      }
      const job = await getNextPendingJob()
      if (job) {
        const rateOk = await canRunJob(job.company_id)
        if (rateOk.ok) {
          processJob(job, io).catch((e) => {
            console.warn(`[queueManager] Erro não tratado em processJob (job ${job.id}):`, e?.message || e)
          })
        } else {
          await supabase.from('jobs').update({
            status: 'pending',
            tentativas: Math.max(0, (job.tentativas || 1) - 1)
          }).eq('id', job.id).eq('company_id', job.company_id).eq('status', 'running')
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
    .eq('company_id', company_id)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

async function requestCancelJob(company_id, tipo) {
  if (!company_id || !tipo) return { ok: false, error: 'company_id e tipo obrigatorios' }

  const job = await getActiveJob(company_id, tipo)
  if (!job?.id) return { ok: false, notFound: true, error: 'Nenhuma sincronizacao ativa encontrada' }

  if (job.status === 'pending') {
    const { data: updated, error: updErr } = await supabase
      .from('jobs')
      .update({
        status: 'cancelled',
        erro: 'Cancelado pelo usuario antes de iniciar',
        atualizado_em: new Date().toISOString(),
      })
      .eq('company_id', Number(company_id))
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (updErr) return { ok: false, error: updErr.message }
    if (!updated?.id) return requestCancelJob(company_id, tipo)
    return { ok: true, cancelled: true, job_id: job.id, status: 'cancelled' }
  }

  const { data: updated, error: updErr } = await supabase
    .from('jobs')
    .update({
      status: 'cancel_requested',
      erro: 'Cancelamento solicitado pelo usuario',
      atualizado_em: new Date().toISOString(),
    })
    .eq('company_id', Number(company_id))
    .eq('id', job.id)
    .in('status', ['running', 'cancel_requested'])
    .select('id')
    .maybeSingle()

  if (updErr) return { ok: false, error: updErr.message }
  if (!updated?.id) return { ok: false, notFound: true, error: 'Nenhuma sincronizacao ativa encontrada' }
  return { ok: true, cancel_requested: true, job_id: job.id, status: 'cancel_requested' }
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
  getActiveJob,
  getNextPendingJob,
  processJob,
  startWorker,
  retryJob,
  requestCancelJob,
  pauseAll,
  resumeAll,
  recoverStaleRunningJobs,
  JOB_TIPOS
}
