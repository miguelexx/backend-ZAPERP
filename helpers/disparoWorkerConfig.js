/**
 * Feature flags e configuração do worker/envio do Disparo (Etapa 7).
 * Worker on por padrão (a API sobe o loop junto com o HTTP).
 * Envio real continua gated: live off e dry-run on até ops ligar.
 */

const os = require('os')

function getBooleanEnv(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw == null || String(raw).trim() === '') return defaultValue
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return defaultValue
}

function getIntEnv(name, defaultValue, min = 1, max = 3600000) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return defaultValue
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function getDisparoFlags() {
  const workerEnabled = getBooleanEnv('DISPARO_WORKER_ENABLED', true)
  const liveEnabled = getBooleanEnv('DISPARO_LIVE_ENABLED', false)
  const dryRun = getBooleanEnv('DISPARO_DRY_RUN', true)
  return {
    workerEnabled,
    liveEnabled,
    dryRun,
    /** Envio real só com as três condições. */
    canSendLive: workerEnabled && liveEnabled && dryRun === false,
  }
}

function getDisparoWorkerConfig() {
  const flags = getDisparoFlags()
  const allowlistRaw = String(process.env.DISPARO_TEST_ALLOWLIST || '').trim()
  const allowlist = allowlistRaw
    ? allowlistRaw.split(/[,;\s]+/).map((s) => s.replace(/\D/g, '')).filter(Boolean)
    : []

  return {
    ...flags,
    pollMs: getIntEnv('DISPARO_WORKER_POLL_MS', 2000, 500, 60000),
    heartbeatMs: getIntEnv('DISPARO_WORKER_HEARTBEAT_MS', 10000, 2000, 60000),
    leaseSeconds: getIntEnv('DISPARO_WORKER_LEASE_SECONDS', 120, 30, 900),
    batchSize: getIntEnv('DISPARO_WORKER_BATCH_SIZE', 5, 1, 50),
    // PID isolado colide entre containers (frequentemente todos usam pid 19/20).
    workerId: String(
      process.env.DISPARO_WORKER_ID || `worker-${os.hostname()}-${process.pid}`,
    ).slice(0, 120),
    sendTimeoutMs: getIntEnv('DISPARO_SEND_TIMEOUT_MS', 45000, 5000, 180000),
    maxTentativas: getIntEnv('DISPARO_MAX_TENTATIVAS', 5, 1, 20),
    backoffBaseSec: getIntEnv('DISPARO_BACKOFF_BASE_SEC', 30, 5, 3600),
    backoffMaxSec: getIntEnv('DISPARO_BACKOFF_MAX_SEC', 3600, 60, 86400),
    allowlist,
  }
}

function telefoneNaAllowlist(telefoneNormalizado, allowlist) {
  if (!allowlist || !allowlist.length) return true
  const digits = String(telefoneNormalizado || '').replace(/\D/g, '')
  return allowlist.some((a) => digits === a || digits.endsWith(a) || a.endsWith(digits))
}

module.exports = {
  getBooleanEnv,
  getIntEnv,
  getDisparoFlags,
  getDisparoWorkerConfig,
  telefoneNaAllowlist,
}
