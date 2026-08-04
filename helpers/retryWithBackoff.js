/**
 * Retry com backoff exponencial para chamadas a APIs externas.
 * Por padrao, retenta apenas metodos idempotentes. POST de envio de mensagem
 * nao deve ser repetido automaticamente sem chave de idempotencia persistente.
 */

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 8000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Erros que provam que a conexao nunca foi estabelecida: nenhum byte da requisicao
 * chegou ao servidor, entao repetir nao pode duplicar o envio.
 * Timeout e ECONNRESET ficam de fora de proposito: o servidor pode ja ter processado
 * a mensagem e o retry duplicaria o envio para o cliente.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isConnectionLevelError(err) {
  if (!err) return false
  const name = String(err.name || '')
  if (name === 'AbortError' || name === 'TimeoutError') return false
  let cursor = err
  for (let depth = 0; cursor && depth < 4; depth++) {
    const code = cursor.code != null ? String(cursor.code) : ''
    if (code && CONNECTION_ERROR_CODES.has(code)) return true
    cursor = cursor.cause
  }
  return false
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Executa fetch com retry.
 * Metodo idempotente (ou retryUnsafe): retenta erro de rede, 5xx, 429 e 408.
 * Metodo nao idempotente com retryConnectionErrors: retenta somente falha de conexao,
 * porque qualquer resposta recebida significa que o envio pode ter sido processado.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, idempotent?: boolean, retryUnsafe?: boolean, retryConnectionErrors?: boolean } | null} [retryOpts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retryOpts = null) {
  const opts = retryOpts || {}
  const method = String(options?.method || 'GET').trim().toUpperCase()
  const canRetry = opts.idempotent === true || opts.retryUnsafe === true || IDEMPOTENT_METHODS.has(method)
  // Metodo nao idempotente: retenta apenas falha de conexao, nunca por resposta recebida.
  const connectionOnlyRetry = !canRetry && opts.retryConnectionErrors === true
  const maxAttempts = canRetry || connectionOnlyRetry ? (opts.maxAttempts ?? MAX_ATTEMPTS) : 1
  const baseDelay = opts.baseDelayMs ?? BASE_DELAY_MS
  let lastErr = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options)
      const shouldRetry =
        canRetry && (res.status >= 500 || res.status === 429 || res.status === 408)
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
      const erroRetentavel = canRetry || (connectionOnlyRetry && isConnectionLevelError(e))
      if (erroRetentavel && attempt < maxAttempts) {
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

module.exports = { fetchWithRetry, sleep, isConnectionLevelError }
