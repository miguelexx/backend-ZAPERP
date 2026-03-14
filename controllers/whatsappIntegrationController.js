const supabase = require('../config/supabase')
const ultramsgIntegrationService = require('../services/ultramsgIntegrationService')
const whatsappConfigService = require('../services/whatsappConfigService')
const { syncContacts } = require('../services/ultramsgContactsSyncService')
const { syncGroups } = require('../services/ultramsgGroupsSyncService')
const { checkGuard, recordQrServed, resetOnConnected, getAttempts, THROTTLE_SECONDS } = require('../services/zapiConnectGuardService')
const { getConfig } = require('../services/configOperacionalService')
const { getProvider } = require('../services/providers')

const { getStatus, getQrCodeImage, restartInstance, getMe, getPhoneCode, buildMeSummary } = ultramsgIntegrationService
const { getEmpresaWhatsappConfig } = whatsappConfigService

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

exports.syncContacts = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  if (!checkCompanyRate(company_id, 'contacts-sync', 60_000, 5)) {
    return res.status(429).json({
      error: 'Muitas sincronizações. Aguarde 1 minuto.',
      retryAfterSeconds: 60
    })
  }
  const result = await syncContacts(company_id)
  if (!result.ok) return res.status(400).json({ ok: false, error: result.errors?.[0] || 'Erro ao sincronizar' })
  return res.json({
    ok: true,
    mode: result.mode,
    totalFetched: result.totalFetched,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped
  })
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
  if (!result.ok) return res.status(400).json({ ok: false, error: result.errors?.[0] || 'Erro ao sincronizar grupos' })
  
  return res.json({
    ok: true,
    totalFetched: result.totalFetched,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped
  })
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
    const provider = await getProvider(company_id)
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
    const provider = await getProvider(company_id)
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
