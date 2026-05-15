const { runAdminAtendimentoAlertaForAllCompanies } = require('./adminAtendimentoAlertaService')

let schedulerStarted = false
let timer = null
let running = false

function parseIntervalMs() {
  const raw = Number(process.env.ADMIN_ATENDIMENTO_ALERTA_INTERVAL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 2
  const safeMinutes = Math.max(1, Math.min(15, Math.round(minutes)))
  return safeMinutes * 60 * 1000
}

async function runCycle() {
  if (running) return
  running = true
  try {
    const startedAt = Date.now()
    const result = await runAdminAtendimentoAlertaForAllCompanies()
    const elapsedMs = Date.now() - startedAt
    if (!result?.ok) {
      console.warn('[adminAlertaScheduler] ciclo com erro', { error: result?.error, elapsedMs })
      return
    }
    if (result.enviadas > 0) {
      console.log('[adminAlertaScheduler] enviadas', { enviadas: result.enviadas, processadas: result.processadas, elapsedMs })
    } else if (result.processadas > 0) {
      console.log('[adminAlertaScheduler] ciclo (alerta ativo; sem envio neste tick — fora da janela de horário ou já enviado hoje)', {
        empresas_com_alerta_ativo: result.processadas,
        elapsedMs,
      })
    }
  } catch (e) {
    console.warn('[adminAlertaScheduler] erro no ciclo:', e?.message || e)
  } finally {
    running = false
  }
}

/**
 * Dispara a verificação de horários periodicamente (sem depender de cron externo).
 * Desative com ADMIN_ATENDIMENTO_ALERTA_SCHEDULER_ENABLED=0
 */
function startAdminAtendimentoAlertaScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

  const disabled = String(process.env.ADMIN_ATENDIMENTO_ALERTA_SCHEDULER_ENABLED || '')
    .trim()
    .toLowerCase()
  if (disabled === '0' || disabled === 'false') {
    console.log('[adminAlertaScheduler] desativado por ADMIN_ATENDIMENTO_ALERTA_SCHEDULER_ENABLED')
    return
  }

  const intervalMs = parseIntervalMs()
  timer = setInterval(() => {
    runCycle().catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    runCycle().catch(() => {})
  }, 25 * 1000)

  console.log('[adminAlertaScheduler] iniciado', {
    intervalMinutes: Math.round(intervalMs / 60000),
  })
}

module.exports = {
  startAdminAtendimentoAlertaScheduler,
}
