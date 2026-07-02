/**
 * Reconcilia mensagens outbound presas em pending/sending.
 *
 * Cenário: UltraMSG aceita o envio (ok=true) mas retorna ID de fila interno ou
 * o webhook message_create/message_ack demora/falha. Este serviço consulta a API
 * UltraMSG (GET /messages por referenceId ou id) e corrige status no banco.
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const {
  isRealWhatsAppId,
  extractUltraMsgMessageId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
} = require('../helpers/whatsappMessageIdHelper')

const deferredTimers = new Map()
const companyProviderCache = new Map()
const COMPANY_CACHE_TTL_MS = 60_000

function parsePositiveIntEnv(name, fallback, { min = 1, max = 10_080 } = {}) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isEnabled() {
  const raw = String(process.env.PENDING_OUTBOUND_RECONCILE_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function getGraceMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_GRACE_MINUTES', 3, { min: 1, max: 120 }) * 60_000
}

function getFailAfterMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_FAIL_AFTER_MINUTES', 60, { min: 5, max: 1440 }) * 60_000
}

function getBatchLimit() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_BATCH_LIMIT', 50, { min: 1, max: 200 })
}

function getLookbackMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_LOOKBACK_HOURS', 168, { min: 1, max: 336 }) * 60 * 60 * 1000
}

function messageAgeMs(row) {
  const ts = Date.parse(String(row?.criado_em || ''))
  return Number.isFinite(ts) ? Date.now() - ts : 0
}

function providerRowStatus(row) {
  return String(row?.status ?? '').trim().toLowerCase()
}

function providerRowAck(row) {
  return String(row?.ack ?? '').trim().toLowerCase()
}

function providerRowIndicatesSuccess(row) {
  const status = providerRowStatus(row)
  const ack = providerRowAck(row)
  if (['sent', 'server', 'device', 'read', 'played', 'delivered'].includes(status)) return true
  if (['sent', 'server', 'device', 'read', 'played', 'delivered'].includes(ack)) return true
  if (/^[1-4]$/.test(ack)) return true
  return false
}

function providerRowIndicatesFailure(row) {
  const status = providerRowStatus(row)
  return ['unsent', 'invalid', 'expired', 'failed', 'error', 'erro'].includes(status)
}

function providerRowInQueue(row) {
  return providerRowStatus(row) === 'queue'
}

function mapProviderAckToStatus(row) {
  const ack = providerRowAck(row)
  if (/^\d+$/.test(ack)) {
    const n = Number(ack)
    if (n <= 0) return 'pending'
    if (n === 1) return 'sent'
    if (n === 2) return 'delivered'
    if (n === 3) return 'read'
    if (n >= 4) return 'played'
  }
  if (['read', 'played', 'seen'].includes(ack)) return ack === 'played' ? 'played' : 'read'
  if (['delivered', 'device', 'received'].includes(ack)) return 'delivered'
  if (['sent', 'server'].includes(ack)) return 'sent'
  if (['pending', 'queue'].includes(ack)) return 'pending'
  if (providerRowIndicatesSuccess(row)) return 'sent'
  return 'sent'
}

function buildProviderOpts(row) {
  return {
    companyId: row.company_id,
    whatsappInstanceId: row.whatsapp_instance_id || undefined,
  }
}

async function fetchProviderMessages(opts, filters = {}) {
  const provider = getProvider()
  if (!provider?.getMessages) return { ok: false, data: [], error: 'provider_indisponivel' }
  try {
    return await provider.getMessages({
      ...opts,
      page: 1,
      limit: Math.min(10, Number(filters.limit) || 5),
      sort: 'desc',
      status: filters.status || 'all',
      ...(filters.referenceId ? { referenceId: filters.referenceId } : {}),
      ...(filters.id ? { id: filters.id } : {}),
    })
  } catch (e) {
    return { ok: false, data: [], error: e?.message || String(e) }
  }
}

function emitStatusUpdate(io, row, payload) {
  if (!io || !row) return
  const eventPayload = {
    mensagem_id: row.id,
    conversa_id: row.conversa_id,
    status: payload.status,
    status_mensagem: payload.status_mensagem || payload.status,
    ...(payload.whatsapp_id ? { whatsapp_id: payload.whatsapp_id } : {}),
  }
  let chain = io.to(`empresa_${row.company_id}`).to(`conversa_${row.conversa_id}`)
  if (row.autor_usuario_id != null) chain = chain.to(`usuario_${row.autor_usuario_id}`)
  chain.emit('status_mensagem', eventPayload)
}

async function patchMessage(row, updates, io) {
  const { data, error } = await supabase
    .from('mensagens')
    .update(updates)
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select('id, company_id, conversa_id, autor_usuario_id, status, status_mensagem, whatsapp_id')
    .maybeSingle()

  if (error || !data) {
    return { ok: false, action: 'patch_failed', error: error?.message || 'update_failed' }
  }

  emitStatusUpdate(io, data, updates)
  return { ok: true, action: 'patched', status: updates.status, mensagem_id: data.id }
}

async function resolveFromProviderRow(row, providerRow, io) {
  if (!providerRow) return { ok: true, action: 'noop' }

  if (providerRowIndicatesFailure(providerRow)) {
    return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
  }

  if (providerRowInQueue(providerRow)) {
    return { ok: true, action: 'keep_queue' }
  }

  if (providerRowIndicatesSuccess(providerRow)) {
    const waId = extractUltraMsgMessageId(providerRow)
    const nextStatus = mapProviderAckToStatus(providerRow)
    const updates = {
      status: nextStatus,
      status_mensagem: nextStatus,
    }
    if (isRealWhatsAppId(waId)) updates.whatsapp_id = String(waId).trim()
    else if (isUltramsgNumericQueueId(waId) && !row.whatsapp_id) updates.whatsapp_id = String(waId).trim()
    return patchMessage(row, updates, io)
  }

  return { ok: true, action: 'noop' }
}

async function queryProviderForMessage(row) {
  const opts = buildProviderOpts(row)
  const referenceId = buildCrmReferenceId(row.id)

  if (referenceId) {
    for (const status of ['all', 'sent', 'queue', 'unsent', 'invalid', 'expired']) {
      const result = await fetchProviderMessages(opts, { referenceId, status, limit: 3 })
      if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
        return { source: `referenceId:${status}`, row: result.data[0], list: result.data }
      }
    }
  }

  const waStored = row.whatsapp_id != null ? String(row.whatsapp_id).trim() : ''
  if (waStored) {
    for (const status of ['all', 'sent', 'queue', 'unsent', 'invalid', 'expired']) {
      const result = await fetchProviderMessages(opts, { id: waStored, status, limit: 3 })
      if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
        return { source: `id:${status}`, row: result.data[0], list: result.data }
      }
    }
  }

  return null
}

async function reconcilePendingOutboundMessage(row, { io = null, force = false } = {}) {
  if (!row?.id || !row?.company_id) return { ok: false, action: 'invalid_row' }

  const ageMs = messageAgeMs(row)
  if (!force && ageMs < getGraceMs()) {
    return { ok: true, action: 'skip_grace' }
  }

  const currentStatus = String(row.status_mensagem || row.status || '').toLowerCase()
  if (!['pending', 'sending'].includes(currentStatus)) {
    return { ok: true, action: 'skip_not_pending' }
  }

  if (isRealWhatsAppId(row.whatsapp_id)) {
    return patchMessage(row, { status: 'sent', status_mensagem: 'sent' }, io)
  }

  const provider = getProvider()
  if (!provider?.getMessages) {
    return { ok: false, action: 'provider_indisponivel' }
  }

  const cacheKey = `${row.company_id}:${row.whatsapp_instance_id || 'default'}`
  const cached = companyProviderCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < COMPANY_CACHE_TTL_MS) {
    if (!cached.configured) {
      if (ageMs >= getFailAfterMs()) {
        return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
      }
      return { ok: true, action: 'skip_sem_instancia' }
    }
  } else if (provider.getConnectionStatus) {
    try {
      const conn = await provider.getConnectionStatus(buildProviderOpts(row))
      const configured = conn?.configured !== false
      companyProviderCache.set(cacheKey, { ts: Date.now(), configured, connected: conn?.connected === true })
      if (!configured) {
        if (ageMs >= getFailAfterMs()) {
          return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
        }
        return { ok: true, action: 'skip_sem_instancia' }
      }
    } catch (_) {
      companyProviderCache.set(cacheKey, { ts: Date.now(), configured: true, connected: null })
    }
  }

  const providerHit = await queryProviderForMessage(row)
  if (providerHit?.row) {
    const resolved = await resolveFromProviderRow(row, providerHit.row, io)
    if (resolved.action !== 'noop') return resolved
  }

  if (ageMs < getFailAfterMs()) {
    return { ok: true, action: 'keep_waiting' }
  }

  // Após fail threshold: só marca erro se o provedor confirmar falha explícita.
  if (providerHit?.list?.some((item) => providerRowIndicatesFailure(item))) {
    return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
  }

  if (providerHit?.list?.some((item) => providerRowInQueue(item))) {
    return { ok: true, action: 'keep_queue_after_fail_window' }
  }

  // Sem confirmação do provedor: mantém pending (não inventar erro).
  return { ok: true, action: 'keep_unknown' }
}

async function fetchPendingOutboundRows({ companyId = null, limit = null, mensagemId = null } = {}) {
  const batch = limit || getBatchLimit()
  const oldestIso = new Date(Date.now() - getLookbackMs()).toISOString()
  const graceIso = new Date(Date.now() - getGraceMs()).toISOString()

  let query = supabase
    .from('mensagens')
    .select('id, company_id, conversa_id, whatsapp_instance_id, whatsapp_id, status, status_mensagem, direcao, criado_em, autor_usuario_id, tipo')
    .eq('direcao', 'out')
    .in('status', ['pending', 'sending'])
    .gte('criado_em', oldestIso)
    .lte('criado_em', graceIso)
    .order('criado_em', { ascending: true })
    .limit(batch)

  if (companyId != null) query = query.eq('company_id', Number(companyId))
  if (mensagemId != null) query = query.eq('id', Number(mensagemId))

  const { data, error } = await query
  if (error) return { ok: false, rows: [], error: error.message }
  const rows = (data || []).filter((row) => {
    const st = String(row.status_mensagem || row.status || '').toLowerCase()
    return ['pending', 'sending'].includes(st)
  })
  return { ok: true, rows }
}

async function runPendingOutboundReconciliation({ io = null, companyId = null, mensagemId = null, force = false } = {}) {
  if (!isEnabled()) return { ok: true, skipped: true, reason: 'disabled' }

  const { ok, rows, error } = await fetchPendingOutboundRows({ companyId, mensagemId })
  if (!ok) return { ok: false, error }

  const summary = {
    ok: true,
    scanned: rows.length,
    patched: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    actions: {},
  }

  for (const row of rows) {
    try {
      const result = await reconcilePendingOutboundMessage(row, { io, force: force || mensagemId != null })
      const action = result.action || (result.ok ? 'ok' : 'failed')
      summary.actions[action] = (summary.actions[action] || 0) + 1
      if (result.action === 'patched') summary.patched += 1
      else if (String(action).startsWith('keep') || action === 'skip_grace' || action === 'skip_not_pending') summary.kept += 1
      else if (action === 'skip_sem_instancia' || action === 'noop') summary.skipped += 1
      else if (!result.ok) summary.failed += 1
    } catch (e) {
      summary.failed += 1
      summary.actions.error = (summary.actions.error || 0) + 1
      console.warn('[pendingOutboundReconciliation] erro em mensagem', {
        mensagem_id: row.id,
        company_id: row.company_id,
        error: e?.message || e,
      })
    }
  }

  if (summary.patched > 0) {
    console.log('[pendingOutboundReconciliation] ciclo concluído', summary)
  }

  return summary
}

function schedulePendingOutboundReconciliation({ companyId, mensagemId, io = null, delayMs = null } = {}) {
  if (!isEnabled()) return
  const cid = Number(companyId)
  const mid = Number(mensagemId)
  if (!Number.isFinite(cid) || !Number.isFinite(mid) || mid <= 0) return

  const key = `${cid}:${mid}`
  if (deferredTimers.has(key)) return

  const delay = Number.isFinite(Number(delayMs))
    ? Math.max(15_000, Math.min(300_000, Number(delayMs)))
    : parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_DEFER_MS', 90_000, { min: 15_000, max: 300_000 })

  const timer = setTimeout(() => {
    deferredTimers.delete(key)
    runPendingOutboundReconciliation({ io, companyId: cid, mensagemId: mid, force: false }).catch((e) => {
      console.warn('[pendingOutboundReconciliation] deferred falhou', {
        company_id: cid,
        mensagem_id: mid,
        error: e?.message || e,
      })
    })
  }, delay)

  if (typeof timer.unref === 'function') timer.unref()
  deferredTimers.set(key, timer)
}

module.exports = {
  runPendingOutboundReconciliation,
  reconcilePendingOutboundMessage,
  schedulePendingOutboundReconciliation,
  _test: {
    providerRowIndicatesSuccess,
    providerRowIndicatesFailure,
    providerRowInQueue,
    mapProviderAckToStatus,
    buildCrmReferenceId,
    getGraceMs,
    getFailAfterMs,
  },
}
