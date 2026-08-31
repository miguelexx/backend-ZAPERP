/**
 * Delay in-memory entre POSTs de envio, por companyId.
 * Processo único (PM2 fork 1). skipProviderDelay só registra o timestamp.
 */

const { MIN_DELAY_BETWEEN_SENDS_MS, LAST_SEND_MAP_MAX } = require('./constants')

const lastSendPerCompany = new Map()

async function awaitSendDelay(companyId, opts = {}) {
  if (MIN_DELAY_BETWEEN_SENDS_MS <= 0) return
  const key = companyId ?? 'default'
  if (opts?.skipProviderDelay) {
    lastSendPerCompany.set(key, Date.now())
    if (lastSendPerCompany.size > LAST_SEND_MAP_MAX) {
      const oldest = lastSendPerCompany.keys().next().value
      lastSendPerCompany.delete(oldest)
    }
    return
  }
  const last = lastSendPerCompany.get(key) || 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_DELAY_BETWEEN_SENDS_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_BETWEEN_SENDS_MS - elapsed))
  }
  lastSendPerCompany.set(key, Date.now())
  if (lastSendPerCompany.size > LAST_SEND_MAP_MAX) {
    const oldest = lastSendPerCompany.keys().next().value
    lastSendPerCompany.delete(oldest)
  }
}

module.exports = { awaitSendDelay }
