'use strict'

const { runAguardandoClienteMonitor } = require('./aguardandoClienteMonitorService')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.AGUARDANDO_CLIENTE_MONITOR_INTERVAL_SECONDS)
  const seconds = Number.isFinite(raw) ? raw : 60
  const safe = Math.max(15, Math.min(600, Math.round(seconds)))
  return safe * 1000
}

async function runCycle(io) {
  if (running) return
  running = true
  try {
    const startedAt = Date.now()
    const result = await runAguardandoClienteMonitor(io)
    const elapsedMs = Date.now() - startedAt
    if (!result?.ok) {
      console.warn('[aguardandoClienteScheduler] ciclo com erro', { result, elapsedMs })
      return
    }
    if (result.escaladas > 0 || result.limpas > 0 || result.vencidas > 0) {
      console.log('[aguardandoClienteScheduler] ciclo concluído', {
        escaladas: result.escaladas,
        vencidas: result.vencidas,
        limpas: result.limpas,
        elapsedMs,
      })
    }
  } catch (e) {
    console.warn('[aguardandoClienteScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

function startAguardandoClienteMonitorScheduler(io = null) {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle(io).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  // Roda rápido no startup para não esperar o primeiro intervalo.
  setTimeout(() => {
    runCycle(io).catch(() => {})
  }, 25 * 1000)

  console.log('[aguardandoClienteScheduler] iniciado', {
    intervalSeconds: Math.round(intervalMs / 1000),
  })
}

module.exports = {
  startAguardandoClienteMonitorScheduler,
}
