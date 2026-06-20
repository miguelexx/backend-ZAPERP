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
      const resumo = (result.detalhes || [])
        .map((d) => `${d.company_id}:${d.reason || (d.sent ? 'sent' : '?')}${d.error ? `(${String(d.error).slice(0, 80)})` : ''}`)
        .join(' | ')
      const hasActionable = (result.detalhes || []).some((d) =>
        ['send_failed', 'invalid_phone', 'invalid_contact_phone', 'contact_not_found', 'contact_lookup_failed', 'reserve_failed', 'no_provider', 'no_metrics_enabled'].includes(d.reason)
      )
      const logFn = hasActionable ? console.warn : console.log
      logFn('[adminAlertaScheduler] ciclo (alerta ativo; sem envio neste tick)', {
        empresas_com_alerta_ativo: result.processadas,
        elapsedMs,
        detalhes: resumo || undefined,
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
 * A liberação do alerta é controlada pela tela, por empresa.
 */
function startAdminAtendimentoAlertaScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

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
