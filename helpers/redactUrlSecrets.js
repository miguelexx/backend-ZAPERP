'use strict'

/**
 * Redige segredos da QUERY STRING antes de qualquer log.
 *
 * Motivo (doc 33, achado F1): `middleware/logger.js` loga `req.originalUrl` de TODA requisição.
 * Duas rotas carregam segredo na query:
 *   - `/webhooks/ultramsg?token=<WHATSAPP_WEBHOOK_TOKEN>` — a API do UltraMSG
 *     (`POST /instance/settings`) só aceita `webhook_url`, não existe campo de header; esse
 *     token é o MESMO que autentica o webhook Whapi.
 *   - `/media/proxy?token=<JWT>` — JWT de usuário (admin: 30 dias).
 * Logado em claro, qualquer um com leitura de log forja webhook ou reusa o JWT.
 *
 * Aqui o valor é substituído por `[REDACTED]` mantendo a CHAVE visível (o rastro de que havia
 * token continua útil para forense). NUNCA remover a redação para "facilitar debug": o par
 * nome-do-parâmetro + tamanho já basta para diagnosticar.
 */

/** Nomes de parâmetro cujo VALOR nunca pode aparecer em log. */
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'accesstoken',
  'auth',
  'authorization',
  'jwt',
  'key',
  'apikey',
  'api_key',
  'secret',
  'client_secret',
  'password',
  'senha',
  'signature',
  'sig',
])

const REDACTED = '[REDACTED]'

function isSensitiveQueryKey(key) {
  return SENSITIVE_QUERY_KEYS.has(String(key || '').trim().toLowerCase())
}

/**
 * Redige a query string de uma URL (absoluta ou relativa, como `req.originalUrl`).
 * Entrada inválida/vazia volta como string vazia; URL sem query volta intacta.
 * Parser manual de propósito: `URLSearchParams` reescreve a codificação do resto da query
 * (`+`, `%20`) e mudaria a URL logada, dificultando casar log com acesso do provedor.
 */
function redactUrlSecrets(url) {
  const raw = url == null ? '' : String(url)
  if (!raw) return ''
  const queryStart = raw.indexOf('?')
  if (queryStart === -1) return raw

  const base = raw.slice(0, queryStart)
  const afterQuery = raw.slice(queryStart + 1)
  // Fragmento (#) não é enviado pelo cliente, mas se vier não deve ser tratado como query.
  const hashStart = afterQuery.indexOf('#')
  const queryPart = hashStart === -1 ? afterQuery : afterQuery.slice(0, hashStart)
  const hashPart = hashStart === -1 ? '' : afterQuery.slice(hashStart)

  const redacted = queryPart
    .split('&')
    .map((pair) => {
      if (!pair) return pair
      const eq = pair.indexOf('=')
      if (eq === -1) return pair
      const key = pair.slice(0, eq)
      return isSensitiveQueryKey(key) ? `${key}=${REDACTED}` : pair
    })
    .join('&')

  return `${base}?${redacted}${hashPart}`
}

/** Atalho para log de requisição: devolve `originalUrl`/`url` já redigido. */
function redactedRequestUrl(req) {
  return redactUrlSecrets(req?.originalUrl || req?.url || '')
}

module.exports = {
  redactUrlSecrets,
  redactedRequestUrl,
  isSensitiveQueryKey,
  SENSITIVE_QUERY_KEYS,
  REDACTED,
}
