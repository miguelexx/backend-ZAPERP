/**
 * whatsappIntegrationController.js — administração HTTP da CONEXÃO WhatsApp (UltraMSG) por empresa/instância.
 * Rotas: `/integrations/whatsapp` (+ alias legado `/integrations/zapi`) — ver `routes/whatsappIntegrationRoutes.js`.
 *
 * Papel: CRUD de instâncias (`listInstances`/`create`/`update`/`activate`/`setDefault`), conexão
 * (`getQrCode`/`getConnectStatus`/`restart`/`phoneCode`), configuração de webhooks no provider, e
 * jobs de sincronização (contatos, mensagens antigas, grupos) enfileirados via `queueManager`.
 * Leitura de mensagens/estatísticas para a tela de integração.
 *
 * Delega para: `ultramsgIntegrationService` (status/QR/restart/me), `whatsappInstanceService`
 * (instâncias/default/duplicidade), `whatsappConfigService` (config+cache), `whatsappConnectGuardService`
 * (throttle de QR por empresa), `providers` (adapter ativo). `company_id` SEMPRE de `req.user.company_id`.
 *
 * NÃO confundir com: `webhookUltramsgController`/`webhookZapiController` (RECEBEM do provider) nem com
 * o adapter de ENVIO em `services/providers/ultramsg/` (mapa: doc 21). Este é o painel de administração.
 */
const supabase = require('../config/supabase')
const ultramsgIntegrationService = require('../services/ultramsgIntegrationService')
const whatsappConfigService = require('../services/whatsappConfigService')
const whatsappInstanceService = require('../services/whatsappInstanceService')
const { enqueue, getActiveJob, requestCancelJob, JOB_TIPOS } = require('../services/queueManager')
const { syncGroups, syncAll } = require('../services/ultramsgGroupsSyncService')
const { checkGuard, recordQrServed, resetOnConnected, getAttempts, THROTTLE_SECONDS } = require('../services/whatsappConnectGuardService')
const { getConfig } = require('../services/configOperacionalService')
const { getProvider } = require('../services/providers')

const { getStatus, getQrCodeImage, restartInstance, getMe, getPhoneCode, buildMeSummary } = ultramsgIntegrationService
const { getEmpresaWhatsappConfig, invalidateEmpresaWhatsappConfigCache } = whatsappConfigService

const perCompanyBuckets = new Map()

function checkCompanyRate(companyId, key, windowMs, max) {
  if (!companyId) return true
  const now = Date.now()
  const k = `${companyId}:${key}`
  let bucket = perCompanyBuckets.get(k)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    perCompanyBuckets.set(k, bucket)
  }
  if (bucket.count >= max) return false
  bucket.count += 1
  return true
}

function getInstanceParam(req) {
  const id = Number(req.params?.id || req.params?.instanceId)
  return Number.isFinite(id) && id > 0 ? id : null
}

function instanceErrorStatus(error) {
  if (/duplicidade|duplicate/i.test(String(error || ''))) return 409
  return /nao encontrada|não encontrada|invalido|inválido/i.test(String(error || '')) ? 404 : 400
}

exports.listInstances = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const result = await whatsappInstanceService.listWhatsappInstances(company_id)
  if (result.error) return res.status(500).json({ error: result.error })
  return res.json({ instances: result.instances || [] })
}

exports.createInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const result = await whatsappInstanceService.createWhatsappInstance(company_id, req.body || {})
  if (result.error) return res.status(400).json({ error: result.error })
  invalidateEmpresaWhatsappConfigCache(company_id)
  return res.status(201).json({ instance: result.instance })
}

exports.updateInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const result = await whatsappInstanceService.updateWhatsappInstance(company_id, id, req.body || {})
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  invalidateEmpresaWhatsappConfigCache(company_id)
  return res.json({ instance: result.instance })
}

exports.activateInstance = async (req, res) => {
  req.body = { ...(req.body || {}), ativo: true }
  return exports.updateInstance(req, res)
}

exports.deactivateInstance = async (req, res) => {
  req.body = { ...(req.body || {}), ativo: false }
  return exports.updateInstance(req, res)
}

exports.setDefaultInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const result = await whatsappInstanceService.setDefaultWhatsappInstance(company_id, id)
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  invalidateEmpresaWhatsappConfigCache(company_id)
  return res.json({ instance: result.instance })
}

exports.getInstanceStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  if (!checkCompanyRate(company_id, `instance-status:${id}`, 60_000, 30)) {
    return res.status(429).json({ error: 'Muitas consultas de status, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const result = await getStatus(company_id, { whatsappInstanceId: id })
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  return res.json({
    connected: !!result.connected,
    smartphoneConnected: !!result.smartphoneConnected,
    needsRestore: !!result.needsRestore,
  })
}

exports.getInstanceQrCode = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  if (!checkCompanyRate(company_id, `instance-qrcode:${id}`, 60_000, 10)) {
    return res.status(429).json({ error: 'Muitas solicitações de QR Code, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const result = await getQrCodeImage(company_id, { whatsappInstanceId: id })
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  if (result.alreadyConnected) return res.json({ alreadyConnected: true, connected: true })
  return res.json({ imageBase64: result.imageBase64, qrBase64: result.imageBase64 })
}

exports.restartInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const result = await restartInstance(company_id, { whatsappInstanceId: id })
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  return res.json({ value: !!result.value })
}

exports.configureInstanceWebhooks = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const appUrl = String(process.env.APP_URL || '').trim()
  if (!appUrl) return res.status(500).json({ error: 'APP_URL não configurado no servidor' })
  const provider = getProvider()
  if (!provider?.configureWebhooks) return res.status(501).json({ error: 'Provider não suporta configureWebhooks' })
  try {
    const results = await provider.configureWebhooks(appUrl, { companyId: company_id, whatsappInstanceId: id })
    const ok = Array.isArray(results) && results.some((r) => r.ok)
    return res.json({
      ok: !!ok,
      webhook_url: `${appUrl}/webhooks/ultramsg?token=***`,
      results,
    })
  } catch (e) {
    console.error('[configureInstanceWebhooks]', e?.message || e)
    return res.status(500).json({ error: e?.message || 'Erro ao configurar webhooks' })
  }
}

exports.getStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'status', 60_000, 30)) {
    return res.status(429).json({ error: 'Muitas consultas de status, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const result = await getStatus(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  if (result.needsRestore) {
    return res.json({ connected: false, needsRestore: true })
  }
  if (result.connected) {
    await resetOnConnected(company_id)
  }
  return res.json({
    connected: result.connected,
    smartphoneConnected: result.smartphoneConnected,
  })
}

exports.getQrCodeLegacy = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'qrcode', 60_000, 10)) {
    return res.status(429).json({ error: 'Muitas solicitações de QR Code, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const result = await getQrCodeImage(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  if (result.alreadyConnected) {
    return res.json({ alreadyConnected: true })
  }
  return res.json({ imageBase64: result.imageBase64 })
}

exports.getQrCode = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'qrcode', 60_000, 10)) {
    const { attemptsLeft } = await getAttempts(company_id)
    return res.status(429).json({
      error: 'throttled',
      retryAfterSeconds: 60,
      attemptsLeft,
    })
  }
  const statusFirst = await getStatus(company_id)
  if (statusFirst.needsRestore) {
    return res.status(409).json({ needsRestore: true })
  }
  if (statusFirst.connected) {
    await resetOnConnected(company_id)
    return res.json({ connected: true })
  }
  if (statusFirst.error) {
    if (statusFirst.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: statusFirst.error })
    }
    return res.status(502).json({ error: statusFirst.error })
  }
  const guardResult = await checkGuard(company_id)
  if (!guardResult.ok) {
    const { attemptsLeft } = await getAttempts(company_id)
    const isBlocked = guardResult.retryAfterSeconds >= 55
    return res.status(429).json({
      error: isBlocked ? 'blocked' : 'throttled',
      retryAfterSeconds: guardResult.retryAfterSeconds,
      attemptsLeft,
    })
  }
  const result = await getQrCodeImage(company_id)
  if (result.needsRestore) {
    return res.status(409).json({ needsRestore: true })
  }
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  if (result.alreadyConnected) {
    await resetOnConnected(company_id)
    return res.json({ connected: true })
  }
  await recordQrServed(company_id)
  const { attemptsLeft } = await getAttempts(company_id)
  const qrBase64 = result.imageBase64
  return res.json({
    connected: false,
    qrBase64,
    nextRefreshSeconds: THROTTLE_SECONDS,
    attemptsLeft,
  })
}

exports.restart = async (req, res) => {
  const company_id = req.user?.company_id
  const result = await restartInstance(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json({ value: !!result.value })
}

exports.connectRestart = async (req, res) => {
  const company_id = req.user?.company_id
  const configResult = await getEmpresaWhatsappConfig(company_id)
  if (configResult.error) {
    return res.json(buildConnectStatusPayload({ hasInstance: false, error: configResult.error }))
  }
  const restartResult = await restartInstance(company_id)
  if (restartResult.error) {
    return res.json(buildConnectStatusPayload({
      hasInstance: true,
      error: restartResult.error,
    }))
  }
  await new Promise(r => setTimeout(r, 1500))
  const statusResult = await getStatus(company_id)
  if (statusResult.error) {
    return res.json(buildConnectStatusPayload({ hasInstance: true, error: statusResult.error }))
  }
  if (statusResult.needsRestore) {
    return res.json(buildConnectStatusPayload({ hasInstance: true, needsRestore: true }))
  }
  if (statusResult.connected) {
    await resetOnConnected(company_id)
    const meResult = await getMe(company_id)
    const meSummary = meResult.data ? buildMeSummary(meResult.data) : null
    return res.json(buildConnectStatusPayload({
      hasInstance: true,
      connected: true,
      smartphoneConnected: statusResult.smartphoneConnected,
      meSummary,
    }))
  }
  return res.json(buildConnectStatusPayload({
    hasInstance: true,
    smartphoneConnected: statusResult.smartphoneConnected,
  }))
}

exports.getMe = async (req, res) => {
  const company_id = req.user?.company_id
  const result = await getMe(company_id)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json(result.data || {})
}

function buildConnectStatusPayload(opts) {
  return {
    hasInstance: !!opts.hasInstance,
    connected: !!opts.connected,
    smartphoneConnected: !!opts.smartphoneConnected,
    needsRestore: !!opts.needsRestore,
    error: opts.error ?? null,
    meSummary: opts.meSummary ?? null,
  }
}

exports.getConnectStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'connect-status', 60_000, 30)) {
    return res.status(429).json({
      error: 'Muitas consultas, tente novamente.',
      retryAfterSeconds: 60,
      ...buildConnectStatusPayload({ hasInstance: false }),
    })
  }
  const configResult = await getEmpresaWhatsappConfig(company_id)
  if (configResult.error) {
    return res.json(buildConnectStatusPayload({
      hasInstance: false,
      error: configResult.error,
    }))
  }
  const statusResult = await getStatus(company_id)
  if (statusResult.error) {
    return res.json(buildConnectStatusPayload({
      hasInstance: true,
      error: statusResult.error,
    }))
  }
  if (statusResult.needsRestore) {
    return res.json(buildConnectStatusPayload({
      hasInstance: true,
      needsRestore: true,
    }))
  }
  if (statusResult.connected) {
    await resetOnConnected(company_id)
    const meResult = await getMe(company_id)
    const meSummary = meResult.data ? buildMeSummary(meResult.data) : null
    return res.json(buildConnectStatusPayload({
      hasInstance: true,
      connected: true,
      smartphoneConnected: statusResult.smartphoneConnected,
      meSummary,
    }))
  }
  return res.json(buildConnectStatusPayload({
    hasInstance: true,
    smartphoneConnected: statusResult.smartphoneConnected,
  }))
}

exports.debugConfig = async (req, res) => {
  const company_id = req.user?.company_id
  const configResult = await getEmpresaWhatsappConfig(company_id)
  if (configResult.error) {
    return res.json({
      company_id: company_id ?? null,
      hasInstance: false,
      ativo: false,
      instance_id: null,
      tokensMasked: true
    })
  }
  return res.json({
    company_id,
    hasInstance: true,
    ativo: true,
    instance_id: configResult.config?.instance_id ?? null,
    tokensMasked: true
  })
}

exports.debugStatus = async (req, res) => {
  const company_id = req.user?.company_id
  const result = await getStatus(company_id)
  if (result.error) {
    return res.json({
      connected: false,
      smartphoneConnected: false,
      needsRestore: false,
      error: result.error
    })
  }
  return res.json({
    connected: !!result.connected,
    smartphoneConnected: !!result.smartphoneConnected,
    needsRestore: !!result.needsRestore,
    error: null
  })
}

exports.configureWebhooks = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const appUrl = String(process.env.APP_URL || '').trim()
  if (!appUrl) return res.status(500).json({ error: 'APP_URL não configurado no servidor' })
  const provider = getProvider()
  if (!provider?.configureWebhooks) {
    return res.status(501).json({ error: 'Provider não suporta configureWebhooks' })
  }
  try {
    const results = await provider.configureWebhooks(appUrl, { companyId: company_id })
    const ok = Array.isArray(results) && results.some((r) => r.ok)
    return res.json({
      ok: !!ok,
      webhook_url: `${appUrl}/webhooks/ultramsg?token=***`,
      results
    })
  } catch (e) {
    console.error('[configureWebhooks]', e?.message || e)
    return res.status(500).json({ error: e?.message || 'Erro ao configurar webhooks' })
  }
}

// Os dois botões usam a mesma validação, fila e importação manual de fotos.
exports.syncContacts = require('./chat/integrationController').sincronizarContatosZapi

exports.syncOldMessages = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Nao autenticado' })

  if (!checkCompanyRate(company_id, 'old-messages-sync', 300_000, 1)) {
    return res.status(429).json({
      error: 'Sincronizacao de mensagens antigas ja iniciada. Aguarde alguns minutos.',
      retryAfterSeconds: 300
    })
  }

  const result = await enqueue(company_id, JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS, {
    requestedBy: req.user?.id || null
  })

  if (!result.ok) {
    const jaRodando = /enfileirado|execu/i.test(result.error || '')
    console.log(`[SYNC-MENSAGENS-ANTIGAS] empresa=${company_id} enqueue: ${result.error}`)
    return res.json({
      ok: true,
      queued: false,
      running: jaRodando,
      message: jaRodando ? 'Sincronizacao de mensagens antigas ja esta em andamento.' : result.error
    })
  }

  console.log(`[SYNC-MENSAGENS-ANTIGAS] empresa=${company_id} job_id=${result.job_id} enfileirado`)
  return res.json({
    ok: true,
    queued: true,
    job_id: result.job_id,
    message: 'Sincronizacao de mensagens antigas iniciada em segundo plano. O historico sera importado em lotes.'
  })
}

exports.getSyncOldMessagesStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Nao autenticado' })

  const job = await getActiveJob(company_id, JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS)
  if (!job?.id) {
    return res.json({ ok: true, running: false, queued: false, cancel_requested: false })
  }

  return res.json({
    ok: true,
    running: job.status === 'running' || job.status === 'cancel_requested',
    queued: job.status === 'pending',
    cancel_requested: job.status === 'cancel_requested',
    job_id: job.id,
    status: job.status,
    message: job.status === 'cancel_requested'
      ? 'Cancelamento solicitado. A sincronizacao vai parar em seguranca.'
      : 'Sincronizacao de mensagens antigas ja esta em andamento.'
  })
}

exports.cancelSyncOldMessages = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Nao autenticado' })

  const result = await requestCancelJob(company_id, JOB_TIPOS.SYNC_MENSAGENS_ANTIGAS)
  if (!result.ok && !result.notFound) {
    return res.status(400).json({ ok: false, error: result.error || 'Erro ao cancelar sincronizacao.' })
  }

  perCompanyBuckets.delete(`${company_id}:old-messages-sync`)

  const payload = result.notFound
    ? {
        ok: true,
        running: false,
        queued: false,
        cancelled: false,
        message: 'Nenhuma sincronizacao ativa encontrada.'
      }
    : {
        ok: true,
        running: result.cancel_requested === true,
        queued: false,
        cancelled: result.cancelled === true,
        cancel_requested: result.cancel_requested === true,
        job_id: result.job_id,
        status: result.status,
        message: result.cancel_requested
          ? 'Cancelamento solicitado. A sincronizacao vai parar em seguranca.'
          : 'Sincronizacao de mensagens antigas cancelada.'
      }

  const io = req.app?.get?.('io')
  if (io && !result.notFound) {
    io.to(`empresa_${company_id}`).emit('whatsapp_sync_mensagens_antigas', payload)
  }

  return res.json(payload)
}

exports.syncGroups = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  
  if (!checkCompanyRate(company_id, 'groups-sync', 60_000, 3)) {
    return res.status(429).json({
      error: 'Muitas sincronizações de grupos. Aguarde 1 minuto.',
      retryAfterSeconds: 60
    })
  }
  
  const result = await syncGroups(company_id)
  if (!result.ok) {
    const errMsg = result.errors?.[0] || 'Erro ao sincronizar grupos'
    const isNoConfig = /sem instância|não configurad|getGroups não disponível/i.test(errMsg)
    return res.status(isNoConfig ? 404 : 400).json({
      ok: false,
      error: errMsg,
      hint: isNoConfig ? 'Configure UltraMsg para esta empresa: node scripts/configurar-ultramsg.js ' + company_id : undefined
    })
  }
  
  return res.json({
    ok: true,
    totalFetched: result.totalFetched,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped
  })
}

exports.syncAll = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

  if (!checkCompanyRate(company_id, 'sync-all', 120_000, 2)) {
    return res.status(429).json({
      error: 'Muitas sincronizações completas. Aguarde 2 minutos.',
      retryAfterSeconds: 120
    })
  }

  const result = await syncAll(company_id)
  return res.json(result)
}

exports.getOperationalStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

  const statusResult = await getStatus(company_id)
  const config = await getConfig(company_id)

  let lastJob = null
  let pendingJob = null
  try {
    const r1 = await supabase
      .from('jobs')
      .select('atualizado_em, resultado_json, status')
      .eq('company_id', company_id)
      .eq('tipo', 'sync_contatos')
      .in('status', ['completed'])
      .order('atualizado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!r1.error) lastJob = r1.data

    const r2 = await supabase
      .from('jobs')
      .select('id')
      .eq('company_id', company_id)
      .eq('tipo', 'sync_contatos')
      .in('status', ['pending', 'running'])
      .limit(1)
      .maybeSingle()
    if (!r2.error) pendingJob = r2.data
  } catch (_) {}

  return res.json({
    connected: statusResult?.connected ?? false,
    syncStatus: pendingJob?.id ? 'running' : 'idle',
    syncPending: !!pendingJob,
    lastSyncAt: lastJob?.atualizado_em ?? null,
    modoSeguro: config?.modo_seguro ?? true,
    processamentoPausado: config?.processamento_pausado ?? false
  })
}

exports.phoneCode = async (req, res) => {
  const company_id = req.user?.company_id
  const phone = req.body?.phone ?? req.body?.numero
  if (!phone) {
    return res.status(400).json({ error: 'Campo phone é obrigatório.' })
  }
  const result = await getPhoneCode(company_id, phone)
  if (result.error) {
    if (result.error === 'Empresa sem instância configurada') {
      return res.status(404).json({ error: result.error })
    }
    if (result.error.includes('Telefone inválido')) {
      return res.status(400).json({ error: result.error })
    }
    return res.status(502).json({ error: result.error })
  }
  return res.json({ code: result.code })
}

exports.getMessages = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) {
    return res.status(401).json({ error: 'Não autenticado' })
  }

  // Rate limiting para evitar abuso
  if (!checkCompanyRate(company_id, 'messages', 60_000, 30)) {
    return res.status(429).json({ 
      error: 'Muitas consultas de mensagens, tente novamente em instantes.', 
      retryAfterSeconds: 60 
    })
  }

  // Validar parâmetros de entrada
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100))
  const status = req.query.status || 'all'
  const sort = ['asc', 'desc'].includes(req.query.sort) ? req.query.sort : 'desc'

  // Validar status permitidos
  const validStatus = ['all', 'queue', 'sent', 'unsent', 'invalid', 'expired']
  if (!validStatus.includes(status)) {
    return res.status(400).json({ 
      error: `Status inválido. Valores permitidos: ${validStatus.join(', ')}` 
    })
  }

  try {
    // Obter provider UltraMsg
    const provider = getProvider()
    if (!provider || !provider.getMessages) {
      return res.status(404).json({ error: 'Empresa sem instância configurada' })
    }

    // Buscar mensagens via UltraMsg
    const result = await provider.getMessages({ 
      companyId: company_id,
      page, 
      limit, 
      status, 
      sort 
    })

    if (!result.ok) {
      return res.status(502).json({ 
        error: result.error || 'Erro ao buscar mensagens' 
      })
    }

    // Retornar dados no formato esperado
    return res.json({
      messages: result.data || [],
      pagination: {
        page,
        limit,
        status,
        sort
      }
    })

  } catch (error) {
    console.error('[GET_MESSAGES_ERROR]', error)
    return res.status(500).json({ 
      error: 'Erro interno ao buscar mensagens' 
    })
  }
}

exports.getMessagesStatistics = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) {
    return res.status(401).json({ error: 'Não autenticado' })
  }

  // Rate limiting
  if (!checkCompanyRate(company_id, 'messages-stats', 60_000, 20)) {
    return res.status(429).json({ 
      error: 'Muitas consultas de estatísticas, tente novamente em instantes.', 
      retryAfterSeconds: 60 
    })
  }

  try {
    // Obter provider UltraMsg
    const provider = getProvider()
    if (!provider || !provider.getMessagesStatistics) {
      return res.status(404).json({ error: 'Empresa sem instância configurada' })
    }

    // Buscar estatísticas via UltraMsg
    const result = await provider.getMessagesStatistics({ companyId: company_id })
    
    if (!result) {
      return res.status(502).json({ 
        error: 'Erro ao buscar estatísticas de mensagens' 
      })
    }

    return res.json(result)

  } catch (error) {
    console.error('[GET_MESSAGES_STATISTICS_ERROR]', error)
    return res.status(500).json({ 
      error: 'Erro interno ao buscar estatísticas' 
    })
  }
}
