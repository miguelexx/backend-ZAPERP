const { processNoSelectionAutoRouting } = require('./chatbotNoSelectionRoutingService')

let schedulerStarted = false
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.CHATBOT_NO_SELECTION_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 1
  return Math.max(1, Math.min(10, Math.round(minutes))) * 60_000
}

function startChatbotNoSelectionRoutingScheduler(io) {
  if (schedulerStarted) return
  schedulerStarted = true
  const intervalMs = parseIntervalMs()

  const runCycle = async () => {
    if (running) return
    running = true
    try {
      const result = await processNoSelectionAutoRouting({ io })
      if (!result.ok) console.warn('[chatbotNoSelectionScheduler] ciclo com erro:', result.error)
      else if (result.processadas > 0) console.log('[chatbotNoSelectionScheduler] processadas:', result.processadas)
    } catch (error) {
      console.warn('[chatbotNoSelectionScheduler] erro:', error?.message || error)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => runCycle().catch(() => {}), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  const startupTimer = setTimeout(() => runCycle().catch(() => {}), 25_000)
  if (typeof startupTimer.unref === 'function') startupTimer.unref()

  console.log('[chatbotNoSelectionScheduler] iniciado', { intervalMinutes: intervalMs / 60_000 })
}

module.exports = { startChatbotNoSelectionRoutingScheduler }
