const { runAtendimentoSemRespostaForAllCompanies } = require('./atendimentoSemRespostaService')
const { withSchedulerRunLock } = require('./schedulerLock')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.ATENDIMENTO_SEM_RESPOSTA_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 1
  const safeMinutes = Math.max(1, Math.min(10, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

function startAtendimentoSemRespostaScheduler(io) {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  const runCycle = async () => {
    if (running) return
    running = true
    try {
      await withSchedulerRunLock('atendimento_sem_resposta', intervalMs * 2, async () => {
        const result = await runAtendimentoSemRespostaForAllCompanies({ dryRun: false, io })
        if (!result.ok) {
          console.warn('[atendimentoSemRespostaScheduler] ciclo com erro', { error: result.error })
          return
        }
        if (result.processadas > 0) {
          console.log('[atendimentoSemRespostaScheduler] processadas', {
            processadas: result.processadas,
          })
        }
      })
    } catch (e) {
      console.warn('[atendimentoSemRespostaScheduler] erro:', e?.message || e)
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
  }, 35 * 1000)

  console.log('[atendimentoSemRespostaScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = { startAtendimentoSemRespostaScheduler, _test: { parseIntervalMs } }
