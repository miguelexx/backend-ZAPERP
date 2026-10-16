/**
 * Varredura periódica da saúde do ACK por canal (F8 do doc 33).
 *
 * Um endpoint só avisa quem abre a tela; o alarme precisa aparecer sozinho no log. Ciclo longo
 * de propósito (30 min por padrão): a pergunta é "o canal parou de confirmar?", que não muda de
 * minuto a minuto, e cada ciclo custa ~3 counts por canal Whapi. O aviso em si é limitado a 1 por
 * canal por hora dentro do serviço.
 */

const { varrerSaudeDeAck } = require('./ackHealthService')

let schedulerStarted = false
let timer = null
let running = false

function habilitado() {
  const raw = String(process.env.ACK_HEALTH_SCHEDULER_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function parseIntervalMs() {
  const raw = Number(process.env.ACK_HEALTH_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 30
  return Math.max(5, Math.min(240, Math.round(minutes))) * 60 * 1000
}

function startAckHealthScheduler() {
  if (schedulerStarted) return
  if (!habilitado()) {
    console.log('[ackHealthScheduler] desligado por ACK_HEALTH_SCHEDULER_ENABLED')
    return
  }
  schedulerStarted = true

  const intervalMs = parseIntervalMs()
  const runCycle = async () => {
    if (running) return
    running = true
    try {
      await varrerSaudeDeAck({})
    } catch (e) {
      console.warn('[ackHealthScheduler] erro:', e?.message || e)
    } finally {
      running = false
    }
  }

  timer = setInterval(() => { runCycle().catch(() => {}) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  // Primeira passada depois do boot, com folga para o banco/instâncias já estarem de pé — e
  // longe o bastante para não concorrer com a reconciliação (45 s).
  setTimeout(() => { runCycle().catch(() => {}) }, 3 * 60 * 1000)

  console.log('[ackHealthScheduler] iniciado', { intervalMinutes: Math.round(intervalMs / 60000) })
}

module.exports = { startAckHealthScheduler }
