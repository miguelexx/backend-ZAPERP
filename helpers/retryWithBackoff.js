/**
 * Retry com backoff exponencial para chamadas a APIs externas.
 * Por padrao, retenta apenas metodos idempotentes. POST de envio de mensagem
 * nao deve ser repetido automaticamente sem chave de idempotencia persistente.
 */

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 8000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Executa fetch com retry.
 * Retenta em: erro de rede, status 5xx, 429 e 408, apenas quando seguro.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, idempotent?: boolean, retryUnsafe?: boolean } | null} [retryOpts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retryOpts = null) {
  const opts = retryOpts || {}
  const method = String(options?.method || 'GET').trim().toUpperCase()
  const canRetry = opts.idempotent === true || opts.retryUnsafe === true || IDEMPOTENT_METHODS.has(method)
  const maxAttempts = canRetry ? (opts.maxAttempts ?? MAX_ATTEMPTS) : 1
  const baseDelay = opts.baseDelayMs ?? BASE_DELAY_MS
  let lastErr = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options)
      const shouldRetry =
        res.status >= 500 || res.status === 429 || res.status === 408
      if (shouldRetry && attempt < maxAttempts) {
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt - 1),
          opts.maxDelayMs ?? MAX_DELAY_MS
        )
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[retry] Attempt ${attempt}/${maxAttempts} failed (${res.status}), retrying in ${delay}ms`
          )
        }
        await sleep(delay)
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < maxAttempts) {
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt - 1),
          opts.maxDelayMs ?? MAX_DELAY_MS
        )
        console.warn(
          `[retry] Attempt ${attempt}/${maxAttempts} network error:`,
          e?.message || e,
          `retrying in ${delay}ms`
        )
        await sleep(delay)
      } else {
        throw e
      }
    }
  }
  throw lastErr
}

module.exports = { fetchWithRetry, sleep }
