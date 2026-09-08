/**
 * Limites anti-ban Whapi (read-only) — protege o número antes de queimar.
 * GET /business/limits/new_chat          → quantos chats NOVOS o número pode iniciar no ciclo.
 * GET /business/limits/reachout_timelock → se o WhatsApp restringiu temporariamente o início de chats.
 *
 * Diferentes de GET /limits (channel.getLimits, limite genérico do canal).
 * Só leitura: nunca dispara WhatsApp. Contrato confirmado via OpenAPI Whapi (2026-09-08). Ver doc 25 §30.
 */

const { get } = require('./http')
const { resolveConfig } = require('./config')

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data) {
  return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Limite de novos chats individuais no ciclo atual.
 * Campos WhatsApp: cap_type, is_capped, cap_status (none|first_warning|second_warning|capped),
 * quota_limit/used/remaining, cycle_start_at/cycle_end_at (unix s).
 * Retorna { ok, capped, capStatus, quotaLimit, quotaUsed, quotaRemaining, cycleEndAt, data }.
 */
async function getNewChatLimit(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/business/limits/new_chat' })
    // 204 = conta sem cap reportado (número maduro / sem restrição). Não é erro.
    if (status === 204) return { ok: true, capped: false, capStatus: 'none', data: null, httpStatus: 204 }
    if (!ok || data?.error) return apiError(status, data)
    const capStatus = data?.cap_status || null
    return {
      ok: true,
      capped: data?.is_capped === true || capStatus === 'capped',
      capStatus,
      quotaLimit: numOrNull(data?.quota_limit),
      quotaUsed: numOrNull(data?.quota_used),
      quotaRemaining: numOrNull(data?.quota_remaining),
      cycleStartAt: numOrNull(data?.cycle_start_at),
      cycleEndAt: numOrNull(data?.cycle_end_at),
      data,
      httpStatus: status,
    }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler limite de novos chats (Whapi): ${e?.message || e}` }
  }
}

/**
 * Timelock de reachout: se o WhatsApp restringiu o início de novos chats.
 * Campos: is_restricted, restricted_until (unix s, nullable), restriction_type.
 * Retorna { ok, restricted, restrictedUntil, restrictionType, data }.
 */
async function getReachoutTimelock(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/business/limits/reachout_timelock' })
    if (status === 204) return { ok: true, restricted: false, data: null, httpStatus: 204 }
    if (!ok || data?.error) return apiError(status, data)
    return {
      ok: true,
      restricted: data?.is_restricted === true,
      restrictedUntil: numOrNull(data?.restricted_until),
      restrictionType: data?.restriction_type || null,
      data,
      httpStatus: status,
    }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler timelock de reachout (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getNewChatLimit,
  getReachoutTimelock,
}
