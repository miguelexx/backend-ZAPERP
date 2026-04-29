const { getBooleanEnv } = require('../config/env')
const { syncProdutosFromWm } = require('./produtosSyncService')

let started = false
let timer = null

function getIntervalMinutes() {
  const parsed = Number.parseInt(process.env.PRODUTOS_SYNC_INTERVAL_MINUTES || '30', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 30
  return Math.max(1, Math.min(720, parsed))
}

async function runSyncCycle() {
  try {
    await syncProdutosFromWm()
  } catch (error) {
    if (error?.statusCode === 409) {
      console.log('[PRODUTOS_SYNC_SCHEDULER] sincronização já em andamento, ciclo ignorado')
      return
    }
    console.error('[PRODUTOS_SYNC_SCHEDULER] erro no ciclo:', error?.message || error)
  }
}

function startProdutosSyncScheduler() {
  if (started) return
  started = true

  const enabled = getBooleanEnv('PRODUTOS_SYNC_ENABLED', false)
  const internalSyncEnabled = getBooleanEnv('PRODUTOS_SYNC_INTERNAL_ENABLED', false)
  if (!enabled) {
    console.log('[PRODUTOS_SYNC_SCHEDULER] desativado por PRODUTOS_SYNC_ENABLED')
    return
  }
  if (!internalSyncEnabled) {
    console.log('[PRODUTOS_SYNC_SCHEDULER] desativado por PRODUTOS_SYNC_INTERNAL_ENABLED')
    return
  }

  const intervalMinutes = getIntervalMinutes()
  const intervalMs = intervalMinutes * 60 * 1000

  timer = setInterval(() => {
    runSyncCycle().catch(() => {})
  }, intervalMs)

  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    runSyncCycle().catch(() => {})
  }, 30 * 1000)

  console.log('[PRODUTOS_SYNC_SCHEDULER] iniciado', { intervalMinutes })
}

module.exports = {
  startProdutosSyncScheduler,
}
