const zapiIntegrationService = require('../services/zapiIntegrationService')
const ultramsgIntegrationService = require('../services/ultramsgIntegrationService')
const { checkGuard, recordQrServed, resetOnConnected, getAttempts, THROTTLE_SECONDS } = require('../services/zapiConnectGuardService')
const { getConfig } = require('../services/configOperacionalService')

const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'ultramsg').toLowerCase()
const integrationService = PROVIDER === 'ultramsg' ? ultramsgIntegrationService : zapiIntegrationService
const { getStatus, getQrCodeImage, restartInstance, getMe, getPhoneCode, buildMeSummary, getEmpresaZapiConfig } = integrationService

// Rate limit simples por empresa/endpoint em memória (complementar ao express-rate-limit global).
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

/**
 * Handler legado: GET /qrcode — retorna { imageBase64 } (retrocompat).
 */
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

/**
 * Handler com guard: POST/GET /connect/qrcode — retorna { connected, qrBase64?, nextRefreshSeconds, attemptsLeft }.
 */
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
  // qrBase64 é base64 puro; front use: src={"data:image/png;base64," + qrBase64}
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

/**
 * POST /connect/restart — reinicia e retorna status completo (contrato /connect/status).
 */
exports.connectRestart = async (req, res) => {
  const company_id = req.user?.company_id
  const configResult = await getEmpresaZapiConfig(company_id)
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

/**
 * Contrato /connect/status: sempre 200 com campos obrigatórios.
 */
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

/**
 * Status completo para fluxo Conectar: status + meSummary (sem tokens).
 * Nunca retorna 404 — sempre 200 com contrato completo.
 */
exports.getConnectStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!checkCompanyRate(company_id, 'connect-status', 60_000, 30)) {
    return res.status(429).json({
      error: 'Muitas consultas, tente novamente.',
      retryAfterSeconds: 60,
      ...buildConnectStatusPayload({ hasInstance: false }),
    })
  }
  const configResult = await getEmpresaZapiConfig(company_id)
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

/**
 * GET /debug-config — diagnóstico config (AUTH). Nunca retorna tokens.
 */
exports.debugConfig = async (req, res) => {
  const company_id = req.user?.company_id
  const configResult = await getEmpresaZapiConfig(company_id)
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

/**
 * GET /debug-status — diagnóstico status (AUTH). Chama getStatus(company_id).
 */
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

/**
 * POST /contacts/sync — executa sync de contatos inline.
 */
exports.syncContacts = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  if (!checkCompanyRate(company_id, 'contacts-sync', 60_000, 5)) {
    return res.status(429).json({
      error: 'Muitas sincronizações. Aguarde 1 minuto.',
      retryAfterSeconds: 60
    })
  }
  const { syncContacts } = require('../services/zapiContactsSyncService')
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

/**
 * GET /operational-status — saúde da sessão: conectado, sync, modo seguro.
 */
exports.getOperationalStatus = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

  const statusResult = await getStatus(company_id)
  const config = await getConfig(company_id)

  let lastJob = null
  let pendingJob = null
  try {
    const supabase = require('../config/supabase')
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
  } catch (_) {
    // Tabela jobs pode não existir — usa defaults
  }

  return res.json({
    connected: statusResult?.connected ?? false,
    syncStatus: pendingJob?.id ? 'running' : 'idle',
    syncPending: !!pendingJob,
    lastSyncAt: lastJob?.atualizado_em ?? null,
    modoSeguro: config?.modo_seguro ?? true,
    processamentoPausado: config?.processamento_pausado ?? false
  })
}

/**
 * POST /phone-code — obtém código de verificação (10-13 dígitos BR).
 */
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

