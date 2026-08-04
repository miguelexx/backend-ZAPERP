/**
 * Camada central de seguranca para envios WhatsApp.
 *
 * Padrao: modo monitor. Nao bloqueia nem altera o fluxo atual.
 * Modos:
 * - off: desliga auditoria/protecao.
 * - monitor: registra envios e risco, sem delay/bloqueio.
 * - soft: aplica apenas pacing leve em memoria, sem bloquear.
 */

const crypto = require('crypto')
const supabase = require('../config/supabase')

const MODE_OFF = 'off'
const MODE_MONITOR = 'monitor'
const MODE_SOFT = 'soft'
const MODE_STRICT = 'strict'
const KNOWN_MODES = new Set([MODE_OFF, MODE_MONITOR, MODE_SOFT, MODE_STRICT])

const SEND_ENDPOINTS = new Set([
  '/messages/chat',
  '/messages/image',
  '/messages/audio',
  '/messages/voice',
  '/messages/video',
  '/messages/document',
  '/messages/sticker',
  '/messages/location',
  '/messages/vcard',
  '/messages/reaction',
])

const AUTOMATION_ORIGIN_PATTERNS = [
  'chatbot',
  'bot',
  'regra',
  'automacao',
  'automatic',
  'fora_horario',
  'ausencia',
  'timeout',
  'encerramento',
  'admin_alerta',
  'campanha',
  'opt_out',
]

const lastSoftSendByKey = new Map()
let auditTableDisabledUntil = 0

function getGuardMode() {
  const raw = String(process.env.WHATSAPP_SEND_GUARD_MODE || MODE_MONITOR).trim().toLowerCase()
  return KNOWN_MODES.has(raw) ? raw : MODE_MONITOR
}

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function shouldTrackEndpoint(endpoint, body = {}) {
  const ep = String(endpoint || '').trim()
  if (!SEND_ENDPOINTS.has(ep)) return false
  if (ep === '/messages/reaction') return true
  return !!body?.to
}

function normalizeOrigin(origin) {
  const value = String(origin || '').trim().toLowerCase()
  return value || 'nao_informado'
}

function inferOriginKind(origin) {
  const normalized = normalizeOrigin(origin)
  if (normalized.includes('human') || normalized.includes('atendente') || normalized.includes('manual')) {
    return 'human'
  }
  if (AUTOMATION_ORIGIN_PATTERNS.some((p) => normalized.includes(p))) {
    return normalized.includes('campanha') ? 'campaign' : 'automation'
  }
  return 'unknown'
}

function riskFor(kind, endpoint) {
  if (kind === 'campaign') return 'high'
  if (kind === 'automation') return 'medium'
  if (String(endpoint || '') === '/messages/reaction') return 'low'
  if (kind === 'human') return 'low'
  return 'medium'
}

function maskTail(value) {
  const s = String(value || '').trim()
  if (!s) return null
  return s.slice(-12)
}

function hashDestination(value) {
  const s = String(value || '').trim()
  if (!s) return null
  const salt = String(process.env.WHATSAPP_SEND_GUARD_HASH_SALT || 'zaperp-whatsapp-send-guard')
  return crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex')
}

function buildContext(input = {}) {
  const body = input.body && typeof input.body === 'object' ? input.body : {}
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const endpoint = String(input.endpoint || '').trim()
  const origin = normalizeOrigin(meta.origin || meta.sendOrigin || meta.source)
  const kind = inferOriginKind(origin)
  const destination = meta.phone || body.to || null
  return {
    company_id: input.companyId ?? input.company_id ?? meta.companyId ?? meta.company_id ?? null,
    // Instancia resolvida pelo provider. Usada apenas para espacar envios por numero;
    // nao vai para a auditoria enquanto a coluna nao existir na tabela de logs.
    whatsapp_instance_id:
      input.whatsappInstanceId ??
      input.whatsapp_instance_id ??
      meta.whatsappInstanceId ??
      meta.whatsapp_instance_id ??
      null,
    conversa_id: meta.conversaId ?? meta.conversa_id ?? null,
    endpoint,
    tipo: meta.type || endpoint.replace('/messages/', '') || 'unknown',
    origem: origin,
    origem_tipo: kind,
    risco: riskFor(kind, endpoint),
    destino_tail: maskTail(destination),
    destino_hash: hashDestination(destination),
    texto_tamanho: Number.isFinite(Number(meta.textLength)) ? Number(meta.textLength) : null,
    arquivo_tamanho: Number.isFinite(Number(meta.fileSize)) ? Number(meta.fileSize) : null,
  }
}

async function sleep(ms) {
  if (!ms || ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Espacamento e por numero do WhatsApp, nao por empresa: uma instancia em rajada
 * nao deve atrasar os outros numeros da mesma empresa, e cada numero tem seu
 * proprio limite no provedor. Cai para a empresa quando a instancia e desconhecida.
 * Prefixos distintos evitam colisao entre as duas formas de chave.
 */
function pacingKey(ctx, kind) {
  const instancia = ctx?.whatsapp_instance_id
  if (instancia != null && String(instancia).trim() !== '') {
    return `inst:${instancia}:${kind}`
  }
  return `company:${ctx?.company_id}:${kind}`
}

function computeSoftDelay(ctx, mode) {
  if (mode !== MODE_SOFT && mode !== MODE_STRICT) return 0
  if (!ctx.company_id) return 0
  const kind = ctx.origem_tipo || 'unknown'
  const defaultHumanMs = 0
  const defaultAutomationMs = 1500
  const intervalMs =
    kind === 'human'
      ? numberFromEnv('WHATSAPP_SEND_GUARD_HUMAN_INTERVAL_MS', defaultHumanMs)
      : numberFromEnv('WHATSAPP_SEND_GUARD_AUTOMATION_INTERVAL_MS', defaultAutomationMs)
  if (intervalMs <= 0) return 0
  const key = pacingKey(ctx, kind)
  const now = Date.now()
  const last = lastSoftSendByKey.get(key) || 0
  const delay = Math.max(0, intervalMs - (now - last))
  lastSoftSendByKey.set(key, now + delay)
  return delay
}

async function beforeWhatsAppSend(input = {}) {
  const mode = getGuardMode()
  const ctx = buildContext(input)
  if (mode === MODE_OFF || !shouldTrackEndpoint(ctx.endpoint, input.body)) {
    return { allow: true, mode, ctx, delayMs: 0, reasons: [] }
  }

  const delayMs = computeSoftDelay(ctx, mode)
  if (delayMs > 0) await sleep(delayMs)

  return {
    allow: true,
    mode,
    ctx,
    delayMs,
    reasons: delayMs > 0 ? ['soft_pacing'] : [],
  }
}

function responseLooksSuccessful(result = {}) {
  const data = result.data
  if (result.ok === false) return false
  if (data?.error && data.error !== false && data.error !== 'false') return false
  if (data?.sent === false || data?.sent === 'false') return false
  return true
}

function extractError(result = {}) {
  const data = result.data
  const raw = data?.error || data?.message || result.error || result.text || null
  if (!raw) return null
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return str.slice(0, 500)
}

function extractMessageId(result = {}) {
  const data = result.data
  const id = data?.id ?? data?.messageId ?? data?.message_id ?? null
  return id ? String(id).slice(0, 200) : null
}

function scheduleAuditInsert(row) {
  if (getGuardMode() === MODE_OFF) return
  if (Date.now() < auditTableDisabledUntil) return
  setImmediate(() => {
    const insertResult = supabase
      .from('whatsapp_envio_guard_logs')
      .insert(row)
    Promise.resolve(insertResult)
      .then((result = {}) => {
        const { error } = result || {}
        if (!error) return
        auditTableDisabledUntil = Date.now() + 60_000
        if (String(process.env.WHATSAPP_SEND_GUARD_DEBUG || '').trim() === '1') {
          console.warn('[whatsappSendGuard] auditoria indisponivel:', error.message || error)
        }
      })
      .catch((e) => {
        auditTableDisabledUntil = Date.now() + 60_000
        if (String(process.env.WHATSAPP_SEND_GUARD_DEBUG || '').trim() === '1') {
          console.warn('[whatsappSendGuard] auditoria falhou:', e?.message || e)
        }
      })
  })
}

function afterWhatsAppSend(input = {}) {
  const guard = input.guard || {}
  const ctx = guard.ctx || buildContext(input)
  if (guard.mode === MODE_OFF || !shouldTrackEndpoint(ctx.endpoint, input.body)) return

  const result = {
    ok: input.ok,
    status: input.status,
    data: input.data,
    text: input.text,
    error: input.error,
  }
  const sucesso = responseLooksSuccessful(result)
  scheduleAuditInsert({
    company_id: ctx.company_id,
    conversa_id: ctx.conversa_id,
    endpoint: ctx.endpoint,
    tipo: ctx.tipo,
    origem: ctx.origem,
    origem_tipo: ctx.origem_tipo,
    risco: ctx.risco,
    modo: guard.mode || getGuardMode(),
    acao: 'allow',
    motivos: guard.reasons || [],
    delay_ms: guard.delayMs || 0,
    destino_tail: ctx.destino_tail,
    destino_hash: ctx.destino_hash,
    texto_tamanho: ctx.texto_tamanho,
    arquivo_tamanho: ctx.arquivo_tamanho,
    status_http: input.status || null,
    sucesso,
    message_id: extractMessageId(result),
    erro: sucesso ? null : extractError(result),
    duracao_ms: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
  })
}

function buildSendMeta(type, phone, opts = {}, extra = {}) {
  return {
    type,
    phone,
    companyId: opts?.companyId ?? opts?.company_id,
    conversaId: opts?.conversaId ?? opts?.conversa_id,
    whatsappInstanceId: opts?.whatsappInstanceId ?? opts?.whatsapp_instance_id,
    origin: opts?.sendOrigin || opts?.origin || opts?.source || 'nao_informado',
    ...extra,
  }
}

module.exports = {
  beforeWhatsAppSend,
  afterWhatsAppSend,
  buildSendMeta,
  shouldTrackEndpoint,
  inferOriginKind,
  getGuardMode,
  _test: { pacingKey, buildContext, computeSoftDelay },
}
