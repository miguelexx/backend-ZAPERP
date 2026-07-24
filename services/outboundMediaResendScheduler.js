/**
 * Varredura periódica que reenvia mídia outbound presa em 'erro' (ver outboundMediaResendService).
 * Garante que áudios/mídias que falharam sejam reentregues mesmo após reinício do processo, sem
 * depender do navegador do atendente. Protegido por lock de scheduler (single-runner multi-instância).
 */

const { runOutboundMediaResendSweep } = require('./outboundMediaResendService')
const { withSchedulerRunLock } = require('./schedulerLock')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.OUTBOUND_MEDIA_RESEND_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 3
  const safeMinutes = Math.max(1, Math.min(30, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

function startOutboundMediaResendScheduler(io) {
  if (schedulerStarted) return
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  const runCycle = async () => {
    if (running) return
    running = true
    try {
      await withSchedulerRunLock('outbound_media_resend', intervalMs * 2, async () => {
        await runOutboundMediaResendSweep({ io })
      })
    } catch (e) {
      console.warn('[outboundMediaResendScheduler] erro:', e?.message || e)
    } finally {
      running = false
    }
  }

  timer = setInterval(() => {
    runCycle().catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  // Primeira passada logo após o boot (depois da reconciliação pending, ~45s).
  setTimeout(() => {
    runCycle().catch(() => {})
  }, 60 * 1000)

  console.log('[outboundMediaResendScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = { startOutboundMediaResendScheduler, _test: { parseIntervalMs } }
