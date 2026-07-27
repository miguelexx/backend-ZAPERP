const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'client_secret',
  'code',
  'instance_token',
  'password',
  'refresh_token',
  'token',
  'webhook_token',
])

function normalizeQueryKey(key) {
  return String(key || '').trim().toLowerCase()
}

/**
 * Remove credenciais da query antes de registrar uma URL.
 *
 * Mantém o caminho e parâmetros não sensíveis para diagnóstico, mas nunca deve
 * ser usado para reconstruir a requisição original.
 */
function sanitizeRequestUrl(value) {
  const raw = String(value || '')
  const queryStart = raw.indexOf('?')
  if (queryStart < 0) return raw

  const path = raw.slice(0, queryStart)
  const queryAndFragment = raw.slice(queryStart + 1)
  const fragmentStart = queryAndFragment.indexOf('#')
  const query = fragmentStart >= 0
    ? queryAndFragment.slice(0, fragmentStart)
    : queryAndFragment
  const fragment = fragmentStart >= 0
    ? queryAndFragment.slice(fragmentStart)
    : ''

  try {
    const params = new URLSearchParams(query)
    const sanitizedParams = new URLSearchParams()
    for (const [key, entryValue] of params.entries()) {
      sanitizedParams.append(
        key,
        SENSITIVE_QUERY_KEYS.has(normalizeQueryKey(key))
          ? '[REDACTED]'
          : entryValue
      )
    }
    const sanitizedQuery = sanitizedParams.toString()
    return `${path}${sanitizedQuery ? `?${sanitizedQuery}` : ''}${fragment}`
  } catch (_) {
    // URLSearchParams é tolerante, mas o fallback também evita retornar o valor
    // integral caso uma entrada excepcional não possa ser analisada.
    return `${path}?query=[UNPARSEABLE]${fragment}`
  }
}

module.exports = {
  SENSITIVE_QUERY_KEYS,
  sanitizeRequestUrl,
}
