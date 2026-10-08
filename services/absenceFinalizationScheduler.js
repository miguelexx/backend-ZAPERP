const { finalizeConversationsByAbsence } = require('./absenceFinalizationService')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.ABSENCE_FINALIZATION_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) ? raw : 5
  const safeMinutes = Math.max(1, Math.min(60, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

async function runCycle(io = null) {
  if (running) return
  running = true
  try {
    const startedAt = Date.now()
    const result = await finalizeConversationsByAbsence({ io })
    const elapsedMs = Date.now() - startedAt
    if (!result?.ok) {
      console.warn('[absenceScheduler] ciclo concluído com erro', { result, elapsedMs })
      return
    }
    // Só loga quando finalizou algo: `analisadas > 0` é verdadeiro em praticamente todo tick
    // com atendimento em andamento (~288 linhas/dia sem informação).
    if (result.processadas > 0) {
      console.log('[absenceScheduler] ciclo concluído', {
        processadas: result.processadas,
        analisadas: result.analisadas,
        elapsedMs,
      })
    }
  } catch (e) {
    console.warn('[absenceScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

function startAbsenceFinalizationScheduler(io = null) {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle(io).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  // Executa rapidamente no startup para não depender do primeiro intervalo.
  setTimeout(() => {
    runCycle(io).catch(() => {})
  }, 20 * 1000)

  console.log('[absenceScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = {
  startAbsenceFinalizationScheduler,
}
