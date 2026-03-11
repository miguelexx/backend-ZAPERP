/**
 * Rate limit interno para operações pesadas.
 * Limite de jobs simultâneos, cooldown entre operações.
 */

const { getConfig } = require('./configOperacionalService')

const activeJobsPerCompany = new Map()
const lastHeavyOpPerCompany = new Map()

/**
 * Verifica se pode executar mais um job para a empresa.
 * @param {number} company_id
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function canRunJob(company_id) {
  const config = await getConfig(company_id)
  const maxConcurrent = config.concorrencia_max ?? 2
  const cooldownSec = config.cooldown_erro_seg ?? 60

  const active = activeJobsPerCompany.get(company_id) || 0
  if (active >= maxConcurrent) {
    return { ok: false, reason: `Máximo de ${maxConcurrent} jobs simultâneos atingido` }
  }

  const lastOp = lastHeavyOpPerCompany.get(company_id) || 0
  const elapsed = (Date.now() - lastOp) / 1000
  if (cooldownSec > 0 && lastOp && elapsed < cooldownSec) {
    return { ok: false, reason: `Cooldown de ${cooldownSec}s entre operações. Aguarde ${Math.ceil(cooldownSec - elapsed)}s` }
  }

  return { ok: true }
}

/**
 * Registra início de job.
 */
function recordJobStart(company_id) {
  const n = (activeJobsPerCompany.get(company_id) || 0) + 1
  activeJobsPerCompany.set(company_id, n)
}

/**
 * Registra fim de job.
 */
function recordJobEnd(company_id) {
  const n = Math.max(0, (activeJobsPerCompany.get(company_id) || 1) - 1)
  activeJobsPerCompany.set(company_id, n)
}

/**
 * Registra operação pesada (para cooldown).
 */
function recordHeavyOp(company_id) {
  lastHeavyOpPerCompany.set(company_id, Date.now())
}

module.exports = {
  canRunJob,
  recordJobStart,
  recordJobEnd,
  recordHeavyOp
}
