const { processAllCompaniesAlertaSemResposta } = require('./atendimentoSemRespostaService')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.ALERTA_SEM_RESPOSTA_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 1
  return Math.max(1, Math.min(15, Math.round(minutes))) * 60 * 1000
}

async function runCycle(io = null) {
  if (running) return
  running = true
  try {
    const startedAt = Date.now()
    const result = await processAllCompaniesAlertaSemResposta({ io })
    const elapsedMs = Date.now() - startedAt
    if (!result?.ok) {
      console.warn('[alertaSemRespostaScheduler] ciclo com erro', { error: result?.error, elapsedMs })
      return
    }
    if (result.empresas > 0 || result.processadas > 0) {
      console.log('[alertaSemRespostaScheduler] ciclo concluido', {
        empresas: result.empresas,
        processadas: result.processadas,
        elapsedMs,
      })
    }
  } catch (e) {
    console.warn('[alertaSemRespostaScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

function startAtendimentoSemRespostaScheduler(io = null) {
  if (schedulerStarted) return
  schedulerStarted = true
  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle(io).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  setTimeout(() => {
    runCycle(io).catch(() => {})
  }, 30 * 1000)
  console.log('[alertaSemRespostaScheduler] iniciado', { intervalMinutes: Math.round(intervalMs / 60000) })
}

module.exports = {
  startAtendimentoSemRespostaScheduler,
}
