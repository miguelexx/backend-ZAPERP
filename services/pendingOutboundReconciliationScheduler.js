const { runPendingOutboundReconciliation } = require('./pendingOutboundReconciliationService')
const { withSchedulerRunLock } = require('./schedulerLock')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.PENDING_OUTBOUND_RECONCILE_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 5
  const safeMinutes = Math.max(1, Math.min(30, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

function startPendingOutboundReconciliationScheduler(io) {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  const runCycle = async () => {
    if (running) return
    running = true
    try {
      await withSchedulerRunLock('pending_outbound_reconciliation', intervalMs * 2, async () => {
        await runPendingOutboundReconciliation({ io })
      })
    } catch (e) {
      console.warn('[pendingOutboundReconciliationScheduler] erro:', e?.message || e)
    } finally {
      running = false
    }
  }

  timer = setInterval(() => {
    runCycle().catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    runCycle().catch(() => {})
  }, 45 * 1000)

  console.log('[pendingOutboundReconciliationScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = { startPendingOutboundReconciliationScheduler, _test: { parseIntervalMs } }
