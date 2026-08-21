const { redirectConversasByNoResponse } = require('./triageRedirectService')

let schedulerStarted = false
let timer = null
let running = false
let _io = null

function parseIntervalMs() {
  const raw = Number(process.env.TRIAGE_REDIRECT_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) ? raw : 1
  const safeMinutes = Math.max(1, Math.min(30, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

async function runCycle() {
  if (running) return
  running = true
  try {
    const startedAt = Date.now()
    const result = await redirectConversasByNoResponse(_io)
    const elapsedMs = Date.now() - startedAt
    if (!result?.ok) {
      console.warn('[triageRedirectScheduler] ciclo com erro', { result, elapsedMs })
      return
    }
    if (result.processadas > 0 || result.analisadas > 0) {
      console.log('[triageRedirectScheduler] ciclo concluído', {
        processadas: result.processadas,
        analisadas: result.analisadas,
        elapsedMs,
      })
    }
  } catch (e) {
    console.warn('[triageRedirectScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

function startTriageRedirectScheduler(io) {
  if (schedulerStarted) return
  schedulerStarted = true
  _io = io

  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle().catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    runCycle().catch(() => {})
  }, 30 * 1000)

  console.log('[triageRedirectScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = { startTriageRedirectScheduler }
