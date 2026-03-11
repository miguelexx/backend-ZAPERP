/**
 * Circuit breaker para chamadas Z-API.
 * Após N falhas consecutivas, abre circuito por X segundos.
 */

const FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, 10) || 5
const RESET_MS = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS, 10) || 60000

const state = new Map()

function getKey(companyId) {
  return `zapi:${companyId ?? 'default'}`
}

function getState(companyId) {
  const key = getKey(companyId)
  let s = state.get(key)
  if (!s) {
    s = { failures: 0, lastFailure: 0, openUntil: 0 }
    state.set(key, s)
  }
  return s
}

/**
 * Verifica se o circuito está aberto.
 * @param {number} [companyId]
 * @returns {boolean}
 */
function isOpen(companyId) {
  const s = getState(companyId)
  if (s.openUntil > Date.now()) return true
  if (s.openUntil > 0 && s.openUntil <= Date.now()) {
    s.failures = 0
    s.openUntil = 0
  }
  return false
}

/**
 * Registra sucesso (reseta falhas).
 */
function recordSuccess(companyId) {
  const s = getState(companyId)
  s.failures = 0
}

/**
 * Registra falha. Retorna true se circuito abriu.
 */
function recordFailure(companyId) {
  const s = getState(companyId)
  s.failures++
  s.lastFailure = Date.now()
  if (s.failures >= FAILURE_THRESHOLD) {
    s.openUntil = Date.now() + RESET_MS
    return true
  }
  return false
}

/**
 * Executa fn se circuito fechado. Registra sucesso/falha.
 * @param {number} companyId
 * @param {function} fn - async () => result
 * @returns {Promise<{ ok: boolean, result?: any, circuitOpen?: boolean }>}
 */
async function execute(companyId, fn) {
  if (isOpen(companyId)) {
    return { ok: false, circuitOpen: true }
  }
  try {
    const result = await fn()
    recordSuccess(companyId)
    return { ok: true, result }
  } catch (e) {
    const opened = recordFailure(companyId)
    if (opened) {
      console.warn(`[circuitBreaker] Circuito aberto para company ${companyId} por ${RESET_MS / 1000}s`)
    }
    return { ok: false, error: e?.message || e, circuitOpen: opened }
  }
}

module.exports = {
  isOpen,
  recordSuccess,
  recordFailure,
  execute,
  FAILURE_THRESHOLD,
  RESET_MS
}
