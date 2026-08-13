/**
 * Cliente mínimo para Cloudflare R2 via API compatível com S3.
 *
 * IMPORTANTE (resposta à ressalva R2 vs S3): NÃO usamos nenhum recurso da AWS.
 * O R2 expõe o MESMO protocolo do S3, então falamos com ele assinando as
 * requisições no padrão AWS Signature V4 (SigV4). O destino é 100% Cloudflare R2
 * (endpoint https://<accountid>.r2.cloudflarestorage.com). Assinamos à mão com o
 * módulo `crypto` nativo para não adicionar a dependência @aws-sdk/client-s3 ao
 * projeto (evita npm install e um pacote pesado em produção).
 *
 * Operações suportadas (path-style: /<bucket>/<key>):
 *   - putObject(key, buffer, contentType)
 *   - deleteObject(key)
 *   - headObject(key)  -> { ok, size, contentType }
 *   - presignGetUrl(key, expiresSeconds) -> URL assinada (query string) para GET
 *
 * Referência: AWS SigV4 (docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html)
 */

const crypto = require('crypto')
const { getR2Config } = require('../../config/r2')

const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.R2_HTTP_TIMEOUT_MS) || 30000)
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')

/** SHA-256 hex de um buffer/string. */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** HMAC-SHA256 devolvendo Buffer (para encadear a derivação da chave). */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

/**
 * URI-encode no padrão RFC 3986 exigido pelo SigV4.
 * Mantém apenas os caracteres "unreserved"; opcionalmente preserva "/".
 */
function encodeRfc3986(str, keepSlash) {
  let out = ''
  const s = String(str)
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      c === '-' || c === '_' || c === '.' || c === '~'
    ) {
      out += c
    } else if (c === '/' && keepSlash) {
      out += c
    } else {
      const bytes = Buffer.from(c, 'utf8')
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Canonical URI: cada segmento do path é URI-encoded, as barras são preservadas. */
function canonicalUriForKey(bucket, key) {
  const cleanKey = String(key || '').replace(/^\/+/, '')
  return `/${encodeRfc3986(bucket, false)}/${encodeRfc3986(cleanKey, true)}`
}

/** Data no formato amz: YYYYMMDDTHHMMSSZ e o datestamp YYYYMMDD. */
function amzDates(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  // iso agora é "YYYYMMDDTHHMMSSZ"
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

function credentialScope(dateStamp, cfg) {
  return `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`
}

function signingKey(cfg, dateStamp) {
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, cfg.service)
  return hmac(kService, 'aws4_request')
}

function hostFromEndpoint(endpoint) {
  return new URL(endpoint).host
}

/**
 * Assina uma requisição com headers (usado em PUT/DELETE/HEAD/GET com corpo conhecido).
 * Retorna { url, headers } prontos para o fetch.
 */
function signRequest({ method, key, payload, contentType, cfg }) {
  const host = hostFromEndpoint(cfg.endpoint)
  const { amzDate, dateStamp } = amzDates()
  const payloadHash = payload && payload.length ? sha256Hex(payload) : EMPTY_SHA256
  const canonicalUri = canonicalUriForKey(cfg.bucket, key)

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (contentType) headers['content-type'] = contentType

  const sortedHeaderKeys = Object.keys(headers).sort()
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('')
  const signedHeaders = sortedHeaderKeys.join(';')

  const canonicalRequest = [
    method,
    canonicalUri,
    '', // sem query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = credentialScope(dateStamp, cfg)
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = crypto
    .createHmac('sha256', signingKey(cfg, dateStamp))
    .update(stringToSign)
    .digest('hex')

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { url: `${cfg.endpoint}${canonicalUri}`, headers }
}

/**
 * Gera URL pré-assinada (query string) para GET — o navegador/provedor baixa
 * direto do R2 sem passar bytes pelo backend. Assinatura via query params (SigV4).
 */
function presignGetUrl(key, expiresSeconds = 900, cfgOverride = null) {
  const cfg = cfgOverride || getR2Config()
  const host = hostFromEndpoint(cfg.endpoint)
  const { amzDate, dateStamp } = amzDates()
  const scope = credentialScope(dateStamp, cfg)
  const canonicalUri = canonicalUriForKey(cfg.bucket, key)

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(604800, Math.max(1, Math.floor(expiresSeconds)))),
    'X-Amz-SignedHeaders': 'host',
  }

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k, false)}=${encodeRfc3986(params[k], false)}`)
    .join('&')

  const canonicalHeaders = `host:${host}\n`
  const signedHeaders = 'host'

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = crypto
    .createHmac('sha256', signingKey(cfg, dateStamp))
    .update(stringToSign)
    .digest('hex')

  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function putObject(key, buffer, contentType) {
  const cfg = getR2Config()
  const { url, headers } = signRequest({
    method: 'PUT',
    key,
    payload: buffer,
    contentType: contentType || 'application/octet-stream',
    cfg,
  })
  const res = await fetchWithTimeout(url, { method: 'PUT', headers, body: buffer })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`R2 putObject falhou: HTTP ${res.status} ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return { ok: true, key, etag: res.headers.get('etag') || null }
}

async function deleteObject(key) {
  const cfg = getR2Config()
  const { url, headers } = signRequest({ method: 'DELETE', key, payload: null, cfg })
  const res = await fetchWithTimeout(url, { method: 'DELETE', headers })
  // 204 (removido) e 404 (já não existe) são ambos sucesso idempotente.
  if (res.status === 204 || res.status === 404 || res.ok) return { ok: true, key }
  const body = await res.text().catch(() => '')
  const err = new Error(`R2 deleteObject falhou: HTTP ${res.status} ${body.slice(0, 200)}`)
  err.status = res.status
  throw err
}

async function headObject(key) {
  const cfg = getR2Config()
  const { url, headers } = signRequest({ method: 'HEAD', key, payload: null, cfg })
  const res = await fetchWithTimeout(url, { method: 'HEAD', headers })
  if (res.status === 404) return { ok: false, exists: false }
  if (!res.ok) {
    const err = new Error(`R2 headObject falhou: HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const size = Number(res.headers.get('content-length') || 0)
  return {
    ok: true,
    exists: true,
    size: Number.isFinite(size) ? size : 0,
    contentType: res.headers.get('content-type') || null,
  }
}

module.exports = {
  putObject,
  deleteObject,
  headObject,
  presignGetUrl,
  _test: {
    encodeRfc3986,
    canonicalUriForKey,
    signRequest,
    amzDates,
    sha256Hex,
  },
}
