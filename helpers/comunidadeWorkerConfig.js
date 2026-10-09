/**
 * Config do worker de Comunidades + limites ULTRA-CONSERVADORES por instância.
 * Padrões pensados para reduzir ao máximo o risco de limitação/bloqueio do número:
 * ~1 adição a cada 30–60s (com jitter), ~20/hora, ~100/dia por instância.
 * Tudo configurável por env e, por instância, em whatsapp_instances.metadata.comunidade_limites.
 */

const os = require('os')

function num(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : def
}

function getComunidadeWorkerConfig() {
  const workerEnabled = String(process.env.COMUNIDADE_WORKER_ENABLED ?? 'true').toLowerCase() !== 'false'
  return {
    workerEnabled,
    workerId: process.env.COMUNIDADE_WORKER_ID || `comunidade-${os.hostname()}-${process.pid}`,
    pollMs: num(process.env.COMUNIDADE_POLL_MS, 5000),
    // 1 item por vez: adicionar participante é a operação de maior risco anti-spam.
    batchSize: num(process.env.COMUNIDADE_BATCH_SIZE, 1),
    leaseSeconds: num(process.env.COMUNIDADE_LEASE_SECONDS, 120),
    heartbeatMs: num(process.env.COMUNIDADE_HEARTBEAT_MS, 15000),
    maxTentativas: num(process.env.COMUNIDADE_MAX_TENTATIVAS, 5),
    backoffBaseSec: num(process.env.COMUNIDADE_BACKOFF_BASE_SEC, 60),
    backoffMaxSec: num(process.env.COMUNIDADE_BACKOFF_MAX_SEC, 3600),
  }
}

/** Limites ultra-conservadores (defaults globais; sobrescritos por instância). */
function getLimitesDefault() {
  return {
    intervaloMinSec: num(process.env.COMUNIDADE_INTERVALO_MIN_SEC, 30),
    intervaloMaxSec: num(process.env.COMUNIDADE_INTERVALO_MAX_SEC, 60),
    porHora: num(process.env.COMUNIDADE_MAX_POR_HORA, 20),
    porDia: num(process.env.COMUNIDADE_MAX_POR_DIA, 100),
  }
}

/**
 * Limites efetivos de uma instância: default global + override em metadata.comunidade_limites.
 * instanceMetadata = whatsapp_instances.metadata (jsonb).
 */
function resolverLimitesInstancia(instanceMetadata) {
  const base = getLimitesDefault()
  const over = instanceMetadata && typeof instanceMetadata === 'object'
    ? (instanceMetadata.comunidade_limites || {})
    : {}
  return {
    intervaloMinSec: num(over.intervaloMinSec, base.intervaloMinSec),
    intervaloMaxSec: num(over.intervaloMaxSec, base.intervaloMaxSec),
    porHora: num(over.porHora, base.porHora),
    porDia: num(over.porDia, base.porDia),
  }
}

/** Intervalo conservador com jitter entre operações (ms). */
function intervaloComJitterMs(limites) {
  const min = Math.max(1, Number(limites.intervaloMinSec) || 30)
  const max = Math.max(min, Number(limites.intervaloMaxSec) || min)
  const sec = min + Math.random() * (max - min)
  return Math.round(sec * 1000)
}

module.exports = {
  getComunidadeWorkerConfig,
  getLimitesDefault,
  resolverLimitesInstancia,
  intervaloComJitterMs,
}
