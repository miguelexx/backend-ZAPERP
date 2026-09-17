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
const { resolveCompanyWhatsappProvider } = require('../services/chat/identity/conversationAddressService')
const whapiPartner = require('../services/providers/whapi/partner')

function publicWebhookUrl(appUrl, providerName) {
  const base = String(appUrl || '').replace(/\/$/, '')
  if (String(providerName || '').toLowerCase() === 'whapi') return `${base}/webhooks/whapi`
  return `${base}/webhooks/ultramsg?token=***`
}

async function persistWhapiHealth(companyId, instanceId, conn) {
  if (!conn || !instanceId) return
  const patch = {
    status: conn.connected ? 'connected' : String(conn.status || 'unknown').slice(0, 40),
    status_at: new Date().toISOString(),
    ultimo_erro: conn.ok ? null : String(conn.error || conn.status || 'health_fail').slice(0, 300),
  }
  if (conn.phone) {
    patch.telefone_conectado = conn.phone
    patch.display_phone = conn.phone
  }
  await whatsappInstanceService.updateWhatsappInstance(companyId, instanceId, patch)
}

function isWhapiProvider(value) {
  return String(value || '').trim().toLowerCase() === 'whapi'
}

function liveConnectedFromStatus(status) {
  const s = String(status || '').trim().toUpperCase()
  return s === 'CONNECTED' || s === 'AUTH' || s === 'READY'
}

function withWhapiLiveFields(instance, conn = null) {
  if (!instance) return instance
  const connected = conn
    ? !!conn.connected
    : (instance.connected === true || liveConnectedFromStatus(instance.status) || liveConnectedFromStatus(instance.live_status))
  return {
    ...instance,
    connected,
    live_status: conn?.status || instance.live_status || instance.status || null,
    is_business: typeof conn?.isBusiness === 'boolean' ? conn.isBusiness : (instance.is_business ?? null),
  }
}

const WHAPI_LIST_HYDRATE_TTL_MS = 8_000
const WHAPI_LIST_HYDRATE_CONCURRENCY = 3
const WHAPI_LIST_HYDRATE_MAX = 8
const whapiListHydrateCache = new Map()

async function mapInBatches(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const part = await Promise.all(chunk.map((item) => fn(item)))
    out.push(...part)
  }
  return out
}

async function hydrateWhapiInstance(companyId, instance) {
  const id = Number(instance?.id)
  if (!id) return withWhapiLiveFields(instance)
  try {
    const conn = await getProvider({ provider: 'whapi' }).getConnectionStatus({
      companyId,
      whatsappInstanceId: id,
    })
    await persistWhapiHealth(companyId, id, conn)
    const fresh = await whatsappInstanceService.getWhatsappInstanceById(companyId, id, { requireActive: false })
    return withWhapiLiveFields(fresh.instance || instance, conn)
  } catch (e) {
    console.warn('[hydrateWhapiInstance]', e?.message || e)
    return withWhapiLiveFields(instance)
  }
}

function applyWhapiHydrateCache(instances, byId) {
  return (instances || []).map((inst) => {
    if (!isWhapiProvider(inst?.provider)) return inst
    const live = byId.get(String(inst.id))
    return live ? { ...inst, ...live } : withWhapiLiveFields(inst)
  })
}

async function hydrateWhapiInstanceList(companyId, instances, { force = false } = {}) {
  const list = Array.isArray(instances) ? instances : []
  const cacheKey = String(companyId)
  const cached = whapiListHydrateCache.get(cacheKey)
  if (!force && cached && (Date.now() - cached.at) < WHAPI_LIST_HYDRATE_TTL_MS) {
    return applyWhapiHydrateCache(list, cached.byId)
  }

  const whapiRows = list.filter((inst) => isWhapiProvider(inst?.provider)).slice(0, WHAPI_LIST_HYDRATE_MAX)
  const byId = new Map()
  await mapInBatches(whapiRows, WHAPI_LIST_HYDRATE_CONCURRENCY, async (inst) => {
    const hydrated = await hydrateWhapiInstance(companyId, inst)
    byId.set(String(inst.id), {
      connected: !!hydrated?.connected,
      live_status: hydrated?.live_status || hydrated?.status || null,
      status: hydrated?.status || inst.status || null,
      display_phone: hydrated?.display_phone || inst.display_phone || null,
      telefone_conectado: hydrated?.telefone_conectado || inst.telefone_conectado || null,
      is_business: typeof hydrated?.is_business === 'boolean' ? hydrated.is_business : null,
    })
  })
  whapiListHydrateCache.set(cacheKey, { at: Date.now(), byId })
  return applyWhapiHydrateCache(list, byId)
}

function rememberWhapiLive(companyId, instance) {
  if (!companyId || !instance?.id) return
  const cached = whapiListHydrateCache.get(String(companyId)) || { at: 0, byId: new Map() }
  cached.byId.set(String(instance.id), {
    connected: !!instance.connected,
    live_status: instance.live_status || instance.status || null,
    status: instance.status || null,
    display_phone: instance.display_phone || null,
    telefone_conectado: instance.telefone_conectado || null,
    is_business: typeof instance.is_business === 'boolean' ? instance.is_business : null,
  })
  cached.at = Date.now()
  whapiListHydrateCache.set(String(companyId), cached)
}

function pickExistingWhapiInstance(instances) {
  const rows = (instances || []).filter((inst) => isWhapiProvider(inst?.provider))
  if (!rows.length) return null
  return rows.find((inst) => inst.ativo !== false && inst.is_default)
    || rows.find((inst) => inst.ativo !== false)
    || rows[0]
}

function whapiMeta() {
  return { partnerEnabled: whapiPartner.isPartnerConfigured() }
}

async function resolveInstanceProviderName(companyId, instanceId) {
  const { instance, error } = await whatsappInstanceService.getWhatsappInstanceById(companyId, instanceId)
  if (!instance) return { providerName: null, instance: null, error: error || 'Instância não encontrada' }
  const providerName = String(instance.provider || '').trim().toLowerCase() === 'whapi' ? 'whapi' : 'ultramsg'
  return { providerName, instance, error: null }
}

/** Company-level: UltraMSG primeiro (produção). Whapi só se a empresa não tiver default UltraMSG. */
async function resolveCompanyWebhookTarget(companyId) {
  const ultra = await whatsappInstanceService.getDefaultWhatsappInstance(companyId, { provider: 'ultramsg' })
  if (ultra.instance) {
    return { providerName: 'ultramsg', whatsappInstanceId: ultra.instance.id }
  }
  const whapi = await whatsappInstanceService.getDefaultWhatsappInstance(companyId, { provider: 'whapi' })
  if (whapi.instance) {
    return { providerName: 'whapi', whatsappInstanceId: whapi.instance.id }
  }
  return { providerName: 'ultramsg', whatsappInstanceId: null }
}

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
  const force = String(req.query?.refresh || '') === '1'
  const canHydrate = checkCompanyRate(company_id, 'list-whapi-hydrate', 60_000, 20)
  let instances = result.instances || []
  if (canHydrate) {
    instances = await hydrateWhapiInstanceList(company_id, instances, { force })
  } else {
    const cached = whapiListHydrateCache.get(String(company_id))
    instances = cached ? applyWhapiHydrateCache(instances, cached.byId) : instances.map((inst) => (
      isWhapiProvider(inst?.provider) ? withWhapiLiveFields(inst) : inst
    ))
  }
  return res.json({ instances, whapi: whapiMeta() })
}

/**
 * Provisiona um canal Whapi via Partner API e grava em whatsapp_instances.
 * O usuário SaaS não cola Channel ID/token. company_id só do JWT.
 * POST /integrations/whatsapp/instances/provision-whapi
 */
exports.provisionWhapiInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  if (!checkCompanyRate(company_id, 'provision-whapi', 10 * 60_000, 3)) {
    return res.status(429).json({
      error: 'Muitas criações de canal. Aguarde alguns minutos.',
      retryAfterSeconds: 600,
      whapi: whapiMeta(),
    })
  }

  const listed = await whatsappInstanceService.listWhatsappInstances(company_id)
  if (listed.error) return res.status(500).json({ error: listed.error, whapi: whapiMeta() })

  // Multi-canal (vários números WHAPI por empresa — ver docs/ai-handoff/28-MULTIPLOS-NUMEROS-WHAPI.md):
  // com a flag explícita `novo` o caller pede um canal ADICIONAL e não reaproveita o existente.
  // SEM a flag o comportamento é o de sempre (idempotente por empresa) — nada muda para quem usa 1 número.
  const wantNew = req.body?.novo === true || req.body?.forceNew === true || req.body?.adicionar === true
  const whapiRows = (listed.instances || []).filter((inst) => isWhapiProvider(inst?.provider))
  const whapiAtivas = whapiRows.filter((inst) => inst?.ativo !== false).length
  const existing = wantNew ? null : pickExistingWhapiInstance(listed.instances)
  if (existing) {
    const instance = await hydrateWhapiInstance(company_id, existing)
    rememberWhapiLive(company_id, instance)
    return res.json({ instance, created: false, whapi: whapiMeta() })
  }

  // Teto de canais ATIVOS por empresa (rede de segurança contra criação em excesso via Partner — cada canal custa).
  // Conta só ativas (consistente com has_multiple do atendimento). Configurável por
  // WHAPI_MAX_CHANNELS_PER_COMPANY (default 5). Só barra quando o caller pede um canal novo.
  const maxChannels = Number(process.env.WHAPI_MAX_CHANNELS_PER_COMPANY || 5)
  if (wantNew && Number.isFinite(maxChannels) && maxChannels > 0 && whapiAtivas >= maxChannels) {
    return res.status(409).json({
      error: `Limite de ${maxChannels} números WhatsApp (Whapi) ativos por empresa atingido. Desative um número antes de adicionar outro.`,
      code: 'WHAPI_MAX_CHANNELS',
      whapi: whapiMeta(),
    })
  }

  if (!whapiPartner.isPartnerConfigured()) {
    return res.status(503).json({
      error: 'Provisionamento automático indisponível: WHAPI_PARTNER_TOKEN não está configurado no servidor.',
      code: 'WHAPI_PARTNER_OFF',
      whapi: whapiMeta(),
    })
  }

  const requestedName = String(req.body?.nome || req.body?.name || '').trim()
  // Nome distinto por canal quando a empresa já tem outros (evita "ZapERP empresa X" repetido no Partner).
  const defaultName = whapiRows.length > 0
    ? `ZapERP empresa ${company_id} #${whapiRows.length + 1}`
    : `ZapERP empresa ${company_id}`
  let channel
  try {
    channel = await whapiPartner.createChannel({
      companyId: company_id,
      name: requestedName || defaultName,
    })
  } catch (e) {
    const status = Number(e?.httpStatus) || 502
    const safeStatus = status >= 400 && status < 600 ? status : 502
    console.warn('[provisionWhapiInstance] partner:', e?.code || e?.message || e)
    return res.status(safeStatus).json({
      error: e?.message || 'Não foi possível criar o canal Whapi.',
      code: e?.code || 'WHAPI_PARTNER',
      whapi: whapiMeta(),
    })
  }

  const result = await whatsappInstanceService.createWhatsappInstance(company_id, {
    provider: 'whapi',
    instance_id: channel.id,
    instance_token: channel.token,
    nome: requestedName || channel.name,
    metadata: { provisioned_by: 'whapi_partner', project_id: channel.projectId || null },
  })
  if (result.error) {
    console.warn('[provisionWhapiInstance] persist:', result.error, 'channel=', String(channel.id).slice(0, 24))
    return res.status(instanceErrorStatus(result.error)).json({
      error: result.error,
      code: result.code || 'WHAPI_PROVISION_PERSIST',
      channel_id: channel.id,
      whapi: whapiMeta(),
    })
  }

  invalidateEmpresaWhatsappConfigCache(company_id)
  let instance = result.instance
  if (isWhapiProvider(instance?.provider)) {
    instance = await hydrateWhapiInstance(company_id, instance)
    rememberWhapiLive(company_id, instance)
  }

  const appUrl = String(process.env.APP_URL || '').trim()
  if (appUrl && instance?.id) {
    try {
      await getProvider({ provider: 'whapi' }).configureWebhooks(appUrl, {
        companyId: company_id,
        whatsappInstanceId: instance.id,
      })
    } catch (e) {
      console.warn('[provisionWhapiInstance] webhook:', e?.message || e)
    }
  }

  return res.status(201).json({ instance, created: true, whapi: whapiMeta() })
}

exports.createInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const result = await whatsappInstanceService.createWhatsappInstance(company_id, req.body || {})
  if (result.error) return res.status(400).json({ error: result.error })
  invalidateEmpresaWhatsappConfigCache(company_id)
  let instance = result.instance
  if (String(instance?.provider || '').toLowerCase() === 'whapi') {
    instance = await hydrateWhapiInstance(company_id, instance)
    rememberWhapiLive(company_id, instance)
  }
  return res.status(201).json({ instance })
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
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  if (resolved.providerName === 'whapi') {
    const conn = await getProvider({ provider: 'whapi' }).getConnectionStatus({
      companyId: company_id,
      whatsappInstanceId: id,
    })
    persistWhapiHealth(company_id, id, conn).catch((e) => {
      console.warn('[getInstanceStatus] persist Whapi health:', e?.message || e)
    })
    return res.json({
      connected: !!conn.connected,
      smartphoneConnected: !!conn.connected,
      needsRestore: false,
      provider: 'whapi',
      status: conn.status || null,
      phone: conn.phone || null,
      is_business: typeof conn.isBusiness === 'boolean' ? conn.isBusiness : null,
    })
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
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  if (resolved.providerName === 'whapi') {
    const whapi = getProvider({ provider: 'whapi' })
    const qr = await whapi.getLoginQr({ companyId: company_id, whatsappInstanceId: id })
    if (qr?.ok && qr.image) {
      // UltraMSG devolve base64 cru; espelhamos o formato (o front prefixa data:).
      const base64 = String(qr.image).replace(/^data:image\/[^;]+;base64,/, '')
      return res.json({ imageBase64: base64, qrBase64: base64, dataUri: qr.image, provider: 'whapi' })
    }
    // Sem QR: normalmente o canal já está conectado (estado AUTH não gera QR).
    const conn = await whapi.getConnectionStatus({ companyId: company_id, whatsappInstanceId: id }).catch(() => null)
    if (conn?.connected) return res.json({ alreadyConnected: true, connected: true, provider: 'whapi' })
    return res.status(502).json({ error: qr?.error || 'Não foi possível obter o QR da Whapi.', provider: 'whapi', connected: false })
  }
  const result = await getQrCodeImage(company_id, { whatsappInstanceId: id })
  if (result.error) return res.status(instanceErrorStatus(result.error)).json({ error: result.error })
  if (result.alreadyConnected) return res.json({ alreadyConnected: true, connected: true })
  return res.json({ imageBase64: result.imageBase64, qrBase64: result.imageBase64 })
}

/**
 * Verifica quais números têm WhatsApp ANTES do disparo. Aditivo — NÃO toca o loop de envio.
 * POST /integrations/whatsapp/instances/:id/check-phones  body { phones: string[], forceCheck? }
 * Só providers com `checkPhones` (hoje Whapi); outros → 501 claro. company_id SEMPRE de req.user.
 */
exports.checkInstancePhones = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const phones = Array.isArray(req.body?.phones) ? req.body.phones
    : (Array.isArray(req.body?.numeros) ? req.body.numeros : null)
  if (!phones || !phones.length) return res.status(400).json({ error: 'Informe phones: string[]' })
  if (phones.length > 500) return res.status(400).json({ error: 'Máximo de 500 números por verificação.' })
  if (!checkCompanyRate(company_id, `check-phones:${id}`, 60_000, 20)) {
    return res.status(429).json({ error: 'Muitas verificações, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  const provider = getProvider({ provider: resolved.providerName })
  if (!provider?.checkPhones) {
    return res.status(501).json({ error: `Provider ${resolved.providerName} não suporta verificação de números.`, provider: resolved.providerName })
  }
  try {
    const results = await provider.checkPhones(phones, {
      companyId: company_id, whatsappInstanceId: id, forceCheck: req.body?.forceCheck === true,
    })
    const validCount = results.filter((r) => r.exists).length
    return res.json({
      provider: resolved.providerName,
      total: results.length,
      validCount,
      invalidCount: results.length - validCount,
      results,
    })
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Falha ao verificar números.', provider: resolved.providerName })
  }
}

/**
 * Código de pareamento por instância (Whapi). Aditivo — não toca o /connect/phone-code (UltraMSG).
 * POST /integrations/whatsapp/instances/:id/phone-code  body { phone }
 */
exports.getInstancePhoneCode = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const phone = req.body?.phone ?? req.body?.numero
  if (!phone) return res.status(400).json({ error: 'Campo phone é obrigatório.' })
  if (!checkCompanyRate(company_id, `phone-code:${id}`, 60_000, 10)) {
    return res.status(429).json({ error: 'Muitas solicitações de código, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  if (resolved.providerName !== 'whapi') {
    return res.status(501).json({ error: 'Pareamento por código por instância só para Whapi. Use /connect/phone-code (UltraMSG).', provider: resolved.providerName })
  }
  const result = await getProvider({ provider: 'whapi' }).getLoginCode(phone, { companyId: company_id, whatsappInstanceId: id })
  if (!result?.ok) {
    return res.status(result?.httpStatus === 409 ? 409 : 502).json({ error: result?.error || 'Não foi possível gerar o código.', provider: 'whapi' })
  }
  return res.json({ code: result.code, provider: 'whapi' })
}

/**
 * Encerra a sessão WhatsApp do canal Whapi (POST /users/logout).
 * Não apaga o cadastro no ZapERP. Aditivo — UltraMSG continua em /connect/restart.
 * POST /integrations/whatsapp/instances/:id/logout
 */
exports.logoutInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  if (!checkCompanyRate(company_id, `logout:${id}`, 60_000, 8)) {
    return res.status(429).json({ error: 'Muitas solicitações de desconexão, tente novamente em instantes.', retryAfterSeconds: 60 })
  }
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  if (resolved.providerName !== 'whapi') {
    return res.status(501).json({ error: 'Logout por instância só para Whapi. Use Reiniciar instância (UltraMSG).', provider: resolved.providerName })
  }
  const result = await getProvider({ provider: 'whapi' }).logoutUser({ companyId: company_id, whatsappInstanceId: id })
  if (!result?.ok) {
    return res.status(502).json({ error: result?.error || 'Não foi possível desconectar o canal.', provider: 'whapi' })
  }
  persistWhapiHealth(company_id, id, { ok: true, connected: false, status: 'LOGOUT' }).catch((e) => {
    console.warn('[logoutInstance] persist Whapi health:', e?.message || e)
  })
  return res.json({ ok: true, alreadyLoggedOut: !!result.alreadyLoggedOut, provider: 'whapi' })
}

exports.restartInstance = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const id = getInstanceParam(req)
  if (!id) return res.status(400).json({ error: 'whatsapp_instance_id inválido' })
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  if (resolved.providerName === 'whapi') {
    return res.status(501).json({
      error: 'Restart UltraMSG não se aplica a canal Whapi. Use o painel Whapi Cloud para a sessão.',
      provider: 'whapi',
    })
  }
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
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) return res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error })
  const provider = getProvider({ provider: resolved.providerName })
  if (!provider?.configureWebhooks) return res.status(501).json({ error: 'Provider não suporta configureWebhooks' })
  try {
    const results = await provider.configureWebhooks(appUrl, { companyId: company_id, whatsappInstanceId: id })
    const ok = Array.isArray(results) && results.some((r) => r.ok)
    return res.json({
      ok: !!ok,
      provider: resolved.providerName,
      webhook_url: publicWebhookUrl(appUrl, resolved.providerName),
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
  const target = await resolveCompanyWebhookTarget(company_id)
  const provider = getProvider({ provider: target.providerName })
  if (!provider?.configureWebhooks) {
    return res.status(501).json({ error: 'Provider não suporta configureWebhooks' })
  }
  try {
    const results = await provider.configureWebhooks(appUrl, {
      companyId: company_id,
      whatsappInstanceId: target.whatsappInstanceId,
    })
    const ok = Array.isArray(results) && results.some((r) => r.ok)
    return res.json({
      ok: !!ok,
      provider: target.providerName,
      webhook_url: publicWebhookUrl(appUrl, target.providerName),
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
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)
    const provider = getProvider({ provider: instanceProvider })
    if (!provider || !provider.getMessages) {
      return res.status(404).json({ error: 'Empresa sem instância configurada' })
    }

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

/**
 * Helper: exige instância Whapi resolvida para endpoints exclusivos do provider (business/presence/getChat).
 * Responde direto (401/404/501) e retorna null em falha; senão { id, provider }.
 */
async function requireWhapiInstance(req, res, rateKey, rateMax = 30) {
  const company_id = req.user?.company_id
  if (!company_id) { res.status(401).json({ error: 'Não autenticado' }); return null }
  const id = getInstanceParam(req)
  if (!id) { res.status(400).json({ error: 'whatsapp_instance_id inválido' }); return null }
  if (rateKey && !checkCompanyRate(company_id, `${rateKey}:${id}`, 60_000, rateMax)) {
    res.status(429).json({ error: 'Muitas solicitações, tente novamente em instantes.', retryAfterSeconds: 60 }); return null
  }
  const resolved = await resolveInstanceProviderName(company_id, id)
  if (!resolved.instance) { res.status(instanceErrorStatus(resolved.error)).json({ error: resolved.error }); return null }
  if (resolved.providerName !== 'whapi') {
    res.status(501).json({ error: `Recurso disponível apenas para instâncias Whapi.`, provider: resolved.providerName }); return null
  }
  return { company_id, id, provider: getProvider({ provider: 'whapi' }) }
}

/** GET /integrations/whatsapp/instances/:id/business-profile — lê o cartão Business (Whapi). */
exports.getInstanceBusinessProfile = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'business-get', 30)
  if (!ctx) return
  try {
    const r = await ctx.provider.getBusinessProfile({ companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.httpStatus === 429 ? 429 : 502)
      return res.status(status).json({
        error: r.error || 'Erro ao ler perfil Business',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', profile: r.profile || {} })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler perfil Business' })
  }
}

/** POST /integrations/whatsapp/instances/:id/business-profile — edita o cartão Business (Whapi). */
exports.updateInstanceBusinessProfile = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'business-set', 15)
  if (!ctx) return
  const { address, description, email, websites, hours } = req.body || {}
  try {
    const r = await ctx.provider.editBusinessProfile({ address, description, email, websites, hours }, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.httpStatus === 429 ? 429 : (r.httpStatus === 400 ? 400 : 502))
      return res.status(status).json({
        error: r.error || 'Erro ao editar perfil Business',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ sucesso: true, provider: 'whapi', profile: r.profile || undefined })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao editar perfil Business' })
  }
}

/** Mapeia o httpStatus do provider para o status HTTP do endpoint de catálogo. */
function catalogErrorStatus(r) {
  if (r?.httpStatus === 422) return 422
  if (r?.httpStatus === 429) return 429
  if (r?.httpStatus === 404) return 404
  return 502
}

/** GET /integrations/whatsapp/instances/:id/catalog/products?count=&offset= — lista o catálogo (Whapi). */
exports.getInstanceCatalogProducts = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-products', 30)
  if (!ctx) return
  const params = { count: req.query?.count, offset: req.query?.offset }
  try {
    const r = await ctx.provider.getCatalogProducts(params, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({
        error: r.error || 'Erro ao ler catálogo',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', products: r.products || [], total: r.total, count: r.count, offset: r.offset })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler catálogo' })
  }
}

/** GET /integrations/whatsapp/instances/:id/catalog/products/:productId — um produto (Whapi). */
exports.getInstanceCatalogProduct = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-product', 60)
  if (!ctx) return
  const productId = String(req.params?.productId || '').trim()
  if (!productId) return res.status(400).json({ error: 'productId é obrigatório.' })
  try {
    const r = await ctx.provider.getCatalogProduct(productId, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({
        error: r.error || 'Erro ao ler produto',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', product: r.product || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler produto' })
  }
}

/** GET /integrations/whatsapp/instances/:id/catalog/collections?count=&offset= — coleções (Whapi). */
exports.getInstanceCatalogCollections = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-collections', 30)
  if (!ctx) return
  const params = { count: req.query?.count, offset: req.query?.offset }
  try {
    const r = await ctx.provider.getCatalogCollections(params, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({
        error: r.error || 'Erro ao ler coleções',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', collections: r.collections || [], total: r.total, count: r.count, offset: r.offset })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler coleções' })
  }
}

/** GET /integrations/whatsapp/instances/:id/catalog/collections/:collectionId — uma coleção (Whapi). */
exports.getInstanceCatalogCollection = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-collection', 60)
  if (!ctx) return
  const collectionId = String(req.params?.collectionId || '').trim()
  if (!collectionId) return res.status(400).json({ error: 'collectionId é obrigatório.' })
  try {
    const r = await ctx.provider.getCatalogCollection(collectionId, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({
        error: r.error || 'Erro ao ler coleção',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', collection: r.collection || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler coleção' })
  }
}

/** GET /integrations/whatsapp/instances/:id/catalog/collections/:collectionId/products — produtos da coleção (Whapi). */
exports.getInstanceCatalogCollectionProducts = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-collection-products', 60)
  if (!ctx) return
  const collectionId = String(req.params?.collectionId || '').trim()
  if (!collectionId) return res.status(400).json({ error: 'collectionId é obrigatório.' })
  try {
    const r = await ctx.provider.getCatalogCollectionProducts(
      collectionId,
      { products_count: req.query?.products_count },
      { companyId: ctx.company_id, whatsappInstanceId: ctx.id },
    )
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({
        error: r.error || 'Erro ao ler produtos da coleção',
        code: r.code || r.providerCode || undefined,
        provider: 'whapi',
      })
    }
    return res.json({ provider: 'whapi', products: r.products || [], total: r.total, count: r.count, offset: r.offset })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler produtos da coleção' })
  }
}

/** POST /integrations/whatsapp/instances/:id/catalog/products — cria produto (Whapi). */
exports.createInstanceCatalogProduct = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-create-product', 20)
  if (!ctx) return
  try {
    const r = await ctx.provider.createCatalogProduct(req.body || {}, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.error && !r.httpStatus ? 400 : catalogErrorStatus(r))
      return res.status(status).json({ error: r.error || 'Erro ao criar produto', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.status(201).json({ provider: 'whapi', product: r.product || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao criar produto' })
  }
}

/** PATCH /integrations/whatsapp/instances/:id/catalog/products/:productId — atualiza produto (Whapi). */
exports.updateInstanceCatalogProduct = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-update-product', 30)
  if (!ctx) return
  const productId = String(req.params?.productId || '').trim()
  if (!productId) return res.status(400).json({ error: 'productId é obrigatório.' })
  try {
    const r = await ctx.provider.updateCatalogProduct(productId, req.body || {}, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.error && !r.httpStatus ? 400 : catalogErrorStatus(r))
      return res.status(status).json({ error: r.error || 'Erro ao atualizar produto', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.json({ provider: 'whapi', product: r.product || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao atualizar produto' })
  }
}

/** DELETE /integrations/whatsapp/instances/:id/catalog/products/:productId — exclui produto (Whapi). */
exports.deleteInstanceCatalogProduct = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-delete-product', 30)
  if (!ctx) return
  const productId = String(req.params?.productId || '').trim()
  if (!productId) return res.status(400).json({ error: 'productId é obrigatório.' })
  try {
    const r = await ctx.provider.deleteCatalogProduct(productId, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({ error: r.error || 'Erro ao excluir produto', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.json({ sucesso: true, provider: 'whapi' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao excluir produto' })
  }
}

/** POST /integrations/whatsapp/instances/:id/catalog/collections — cria coleção (Whapi). */
exports.createInstanceCatalogCollection = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-create-collection', 20)
  if (!ctx) return
  try {
    const r = await ctx.provider.createCatalogCollection(req.body || {}, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.error && !r.httpStatus ? 400 : catalogErrorStatus(r))
      return res.status(status).json({ error: r.error || 'Erro ao criar coleção', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.status(201).json({ provider: 'whapi', collection: r.collection || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao criar coleção' })
  }
}

/** PATCH /integrations/whatsapp/instances/:id/catalog/collections/:collectionId — edita coleção (Whapi). */
exports.editInstanceCatalogCollection = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-edit-collection', 30)
  if (!ctx) return
  const collectionId = String(req.params?.collectionId || '').trim()
  if (!collectionId) return res.status(400).json({ error: 'collectionId é obrigatório.' })
  const { name, add_products, remove_products } = req.body || {}
  try {
    const r = await ctx.provider.editCatalogCollection(collectionId, { name, add_products, remove_products }, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      const status = r.httpStatus === 422 ? 422 : (r.error && !r.httpStatus ? 400 : catalogErrorStatus(r))
      return res.status(status).json({ error: r.error || 'Erro ao editar coleção', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.json({ provider: 'whapi', collection: r.collection || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao editar coleção' })
  }
}

/** DELETE /integrations/whatsapp/instances/:id/catalog/collections/:collectionId — exclui coleção (Whapi). */
exports.deleteInstanceCatalogCollection = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'catalog-delete-collection', 30)
  if (!ctx) return
  const collectionId = String(req.params?.collectionId || '').trim()
  if (!collectionId) return res.status(400).json({ error: 'collectionId é obrigatório.' })
  try {
    const r = await ctx.provider.deleteCatalogCollection(collectionId, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.status(catalogErrorStatus(r)).json({ error: r.error || 'Erro ao excluir coleção', code: r.code || r.providerCode || undefined, provider: 'whapi' })
    }
    return res.json({ sucesso: true, provider: 'whapi' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao excluir coleção' })
  }
}

/** GET /integrations/whatsapp/instances/:id/chats/:chatId — metadados de um chat (Whapi). */
exports.getInstanceChat = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'get-chat', 60)
  if (!ctx) return
  const chatId = String(req.params?.chatId || '').trim()
  if (!chatId) return res.status(400).json({ error: 'chatId é obrigatório.' })
  try {
    const r = await ctx.provider.getChat(chatId, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) return res.status(r.httpStatus === 404 ? 404 : 502).json({ error: r.error || 'Erro ao ler chat', provider: 'whapi' })
    return res.json({ provider: 'whapi', chat: r.chat || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler chat' })
  }
}

/**
 * GET /integrations/whatsapp/instances/:id/presence?entry=... — última presença conhecida (Whapi).
 * Assina automaticamente antes de ler (subscribePresence é precondição p/ o canal reportar).
 */
exports.getInstancePresence = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'presence-get', 60)
  if (!ctx) return
  const entry = String(req.query?.entry || req.query?.chat || req.query?.telefone || '').trim()
  if (!entry) return res.status(400).json({ error: 'Informe entry (telefone ou chat id).' })
  const opts = { companyId: ctx.company_id, whatsappInstanceId: ctx.id }
  try {
    if (req.query?.subscribe !== 'false') {
      await ctx.provider.subscribePresence(entry, opts)
    }
    const r = await ctx.provider.getPresence(entry, opts)
    if (!r.ok) {
      return res.json({
        provider: 'whapi',
        status: null,
        last_seen: null,
        entry_id: null,
        pending: true,
        warning: r.error || 'Presença indisponível no momento',
      })
    }
    return res.json({ provider: 'whapi', status: r.status, last_seen: r.lastSeen, entry_id: r.entryId, pending: false })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler presença' })
  }
}

/** POST /integrations/whatsapp/instances/:id/presence/subscribe body { entry } — assina presença (Whapi). */
exports.subscribeInstancePresence = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'presence-sub', 60)
  if (!ctx) return
  const entry = String(req.body?.entry || req.body?.chat || req.body?.telefone || '').trim()
  if (!entry) return res.status(400).json({ error: 'Informe entry (telefone ou chat id).' })
  try {
    const r = await ctx.provider.subscribePresence(entry, { companyId: ctx.company_id, whatsappInstanceId: ctx.id })
    if (!r.ok) {
      return res.json({
        sucesso: false,
        provider: 'whapi',
        pending: true,
        warning: r.error || 'Não foi possível assinar presença no momento',
      })
    }
    return res.json({ sucesso: true, provider: 'whapi' })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao assinar presença' })
  }
}

/**
 * GET /integrations/whatsapp/instances/:id/limits/antiban — limites anti-ban (Whapi, read-only).
 * Combina getNewChatLimit + getReachoutTimelock para a UI de conexão/disparo.
 */
exports.getInstanceAntibanLimits = async (req, res) => {
  const ctx = await requireWhapiInstance(req, res, 'antiban-limits', 30)
  if (!ctx) return
  const opts = { companyId: ctx.company_id, whatsappInstanceId: ctx.id }
  try {
    const [newChat, reachout] = await Promise.all([
      ctx.provider.getNewChatLimit(opts),
      ctx.provider.getReachoutTimelock(opts),
    ])
    if (!newChat?.ok && !reachout?.ok) {
      return res.status(502).json({
        error: newChat?.error || reachout?.error || 'Erro ao ler limites anti-ban',
        provider: 'whapi',
      })
    }
    return res.json({
      provider: 'whapi',
      new_chat: newChat?.ok
        ? {
            capped: newChat.capped === true,
            cap_status: newChat.capStatus || null,
            quota_limit: newChat.quotaLimit ?? null,
            quota_used: newChat.quotaUsed ?? null,
            quota_remaining: newChat.quotaRemaining ?? null,
            cycle_start_at: newChat.cycleStartAt ?? null,
            cycle_end_at: newChat.cycleEndAt ?? null,
            http_status: newChat.httpStatus ?? null,
          }
        : { error: newChat?.error || 'falha', capped: false },
      reachout: reachout?.ok
        ? {
            restricted: reachout.restricted === true,
            restricted_until: reachout.restrictedUntil ?? null,
            restriction_type: reachout.restrictionType || null,
            http_status: reachout.httpStatus ?? null,
          }
        : { error: reachout?.error || 'falha', restricted: false },
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler limites anti-ban' })
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
    const instanceProvider = await resolveCompanyWhatsappProvider(company_id)
    const provider = getProvider({ provider: instanceProvider })
    if (!provider || !provider.getMessagesStatistics) {
      return res.status(404).json({ error: 'Empresa sem instância configurada' })
    }

    // Buscar estatísticas via UltraMsg
    const result = await provider.getMessagesStatistics({ companyId: company_id })
    
    if (!result || result.notImplemented) {
      return res.status(501).json({
        error: 'Estatísticas de fila não disponíveis neste provedor.',
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
