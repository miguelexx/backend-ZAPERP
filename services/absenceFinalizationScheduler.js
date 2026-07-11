const { finalizeConversationsByAbsence } = require('./absenceFinalizationService')
const { withSchedulerRunLock } = require('./schedulerLock')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.ABSENCE_FINALIZATION_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) ? raw : 5
  const safeMinutes = Math.max(1, Math.min(60, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

async function runCycle() {
  if (running) return
  running = true
  try {
    await withSchedulerRunLock('absence_finalization', parseIntervalMs() * 2, async () => {
      const startedAt = Date.now()
      const result = await finalizeConversationsByAbsence()
      const elapsedMs = Date.now() - startedAt
      if (!result?.ok) {
        console.warn('[absenceScheduler] ciclo concluido com erro', { result, elapsedMs })
        return
      }
      if (result.processadas > 0 || result.analisadas > 0) {
        console.log('[absenceScheduler] ciclo concluido', {
          processadas: result.processadas,
          analisadas: result.analisadas,
          elapsedMs,
        })
      }
    })
  } catch (e) {
    console.warn('[absenceScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

function startAbsenceFinalizationScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle().catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    runCycle().catch(() => {})
  }, 20 * 1000)

  console.log('[absenceScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = {
  startAbsenceFinalizationScheduler,
  _test: { runCycle, parseIntervalMs },
}
