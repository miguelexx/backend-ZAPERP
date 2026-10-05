/**
 * Proxy server-side de URLs de mídia (ex.: S3 UltraMsg) para o frontend poder
 * baixar bytes com autenticação sem depender de CORS no bucket externo.
 */

const { isAllowedInboundMediaUrl: isAllowedMediaUrl } = require('../helpers/allowedInboundMediaUrl')
const { contentTypeFromAudioMagicBytes } = require('../helpers/audioFormatSniffer')
const { sanitizeDownloadFilename, buildContentDisposition } = require('../helpers/contentDisposition')

const MAX_BYTES = 80 * 1024 * 1024 // 80 MB (impressão / preview)
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MEDIA_PROXY_TIMEOUT_MS) || 30000)
const MAX_REDIRECTS = 3
const MAX_PROXY_UNWRAPS = 3

/**
 * Cache em memória do corpo proxiado + deduplicação de downloads em voo.
 *
 * O <audio>/<video> gera VÁRIAS requisições para a MESMA URL em segundos (duplo load do
 * mount, sonda de duração via Range, recarga dos vigias de 4s/6s do player) e cada uma
 * baixava o arquivo INTEIRO do provedor de novo — em upstream lento, o primeiro byte só
 * saía após o download completo e o player declarava o áudio indisponível. Com o cache,
 * só o primeiro pedido baixa; os demais (e todos os Range) servem da memória.
 *
 * A resposta já era imutável por contrato (Cache-Control immutable): conteúdo por URL
 * nunca muda, então servir do cache é seguro. Desligável com MEDIA_PROXY_CACHE_DISABLED=1.
 */
const CACHE_TTL_MS = Math.max(10_000, Number(process.env.MEDIA_PROXY_CACHE_TTL_MS) || 10 * 60 * 1000)
const CACHE_MAX_TOTAL_BYTES = Math.max(1024 * 1024, Number(process.env.MEDIA_PROXY_CACHE_MAX_BYTES) || 64 * 1024 * 1024)
const CACHE_MAX_ITEM_BYTES = Math.max(64 * 1024, Number(process.env.MEDIA_PROXY_CACHE_MAX_ITEM_BYTES) || 12 * 1024 * 1024)

function cacheDisabled() {
  return String(process.env.MEDIA_PROXY_CACHE_DISABLED || '').trim() === '1'
}

const _bodyCache = new Map() // key → { body: Buffer, ct: string, ts: number } (inserção = LRU)
let _cacheBytes = 0
const _inflight = new Map() // key → Promise<{ ok, body?, upstreamCt?, status? }>

function cacheGet(key) {
  const e = _bodyCache.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    _bodyCache.delete(key)
    _cacheBytes -= e.body.length
    return null
  }
  // bump LRU
  _bodyCache.delete(key)
  _bodyCache.set(key, e)
  return e
}

function cachePut(key, body, ct) {
  if (cacheDisabled() || !key || !body || body.length > CACHE_MAX_ITEM_BYTES) return
  const prev = _bodyCache.get(key)
  if (prev) {
    _bodyCache.delete(key)
    _cacheBytes -= prev.body.length
  }
  while (_cacheBytes + body.length > CACHE_MAX_TOTAL_BYTES && _bodyCache.size > 0) {
    const oldestKey = _bodyCache.keys().next().value
    const oldest = _bodyCache.get(oldestKey)
    _bodyCache.delete(oldestKey)
    _cacheBytes -= oldest.body.length
  }
  _bodyCache.set(key, { body, ct, ts: Date.now() })
  _cacheBytes += body.length
}

/** Limpa cache e downloads em voo (testes). */
function resetMediaProxyCache() {
  _bodyCache.clear()
  _cacheBytes = 0
  _inflight.clear()
}

/** Mapa extensão → MIME type. Cobre os formatos mais comuns do ZapERP. */
const MIME_BY_EXT = {
  // Imagens
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  bmp:  'image/bmp',
  svg:  'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  // Vídeos
  mp4:  'video/mp4',
  mov:  'video/quicktime',
  webm: 'video/webm',
  avi:  'video/x-msvideo',
  '3gp':'video/3gpp',
  m4v:  'video/x-m4v',
  mkv:  'video/x-matroska',
  // Áudio
  mp3:  'audio/mpeg',
  m4a:  'audio/mp4',
  ogg:  'audio/ogg',
  opus: 'audio/ogg',
  wav:  'audio/wav',
  aac:  'audio/aac',
  amr:  'audio/amr',
  // Documentos
  pdf:  'application/pdf',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt:  'text/plain',
  csv:  'text/csv',
  xml:  'application/xml',
  json: 'application/json',
  // Compactados
  zip:  'application/zip',
  rar:  'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
}

const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/']
const INLINE_MIME_EXACT = new Set(['application/pdf'])
const GENERIC_CONTENT_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
])

/**
 * Tenta determinar o MIME type a partir de um nome de arquivo ou path de URL.
 * Retorna '' quando não consegue identificar.
 */
function mimeFromFilename(name) {
  if (!name) return ''
  const m = String(name).match(/\.([a-z0-9]{2,8})$/i)
  if (!m) return ''
  return MIME_BY_EXT[m[1].toLowerCase()] || ''
}

/** Extrai o trecho final do path da URL como candidato a filename. */
function filenameFromUrlPath(urlStr) {
  try {
    const u = new URL(urlStr)
    const parts = u.pathname.split('/')
    const last = parts[parts.length - 1]
    const decoded = decodeURIComponent(last || '')
    // Só aceita se tiver extensão conhecida (evita UUIDs sem ext)
    if (decoded && /\.[a-z0-9]{2,8}$/i.test(decoded)) return decoded
  } catch {
    /* ignore */
  }
  return ''
}

function isMediaProxyPath(pathname) {
  return pathname === '/media/proxy' || pathname === '/api/media/proxy'
}

/**
 * Remove camadas acidentais de /media/proxy?url=/media/proxy?... antes de
 * validar o destino real. O destino final continua passando pela allowlist,
 * portanto isto não amplia os hosts que o servidor pode acessar.
 */
function unwrapNestedProxyTarget(raw) {
  let current = new URL(raw)

  for (let i = 0; i < MAX_PROXY_UNWRAPS && isMediaProxyPath(current.pathname); i += 1) {
    const inner = current.searchParams.get('url')
    if (!inner) break
    current = new URL(inner)
  }

  if (isMediaProxyPath(current.pathname) && current.searchParams.get('url')) {
    const err = new Error('too_many_proxy_layers')
    err.code = 'TOO_MANY_PROXY_LAYERS'
    throw err
  }

  return current
}

/**
 * PDFs recebidos e persistidos localmente ficam em APP_URL/uploads. Permitir
 * somente esse path no host público da própria aplicação evita um 403 quando
 * um cliente antigo envia o arquivo local ao proxy, sem liberar outros paths.
 */
function isOwnPublicUploadUrl(target) {
  try {
    const appUrl = new URL(String(process.env.APP_URL || '').trim())
    return (
      target.protocol === 'https:' &&
      target.origin === appUrl.origin &&
      String(target.pathname || '').startsWith('/uploads/')
    )
  } catch {
    return false
  }
}

/**
 * Mídia migrada ao Cloudflare R2 é servida pela própria aplicação em APP_URL/media/r2/<key>.
 * Quando o frontend pede áudio/mídia por este proxy (ex.: player de áudio), reconhecemos esse
 * caminho para gerar a URL assinada do R2 direto — sem depender da allowlist externa nem do 302.
 */
function isOwnR2DeliveryUrl(target) {
  try {
    const appUrl = new URL(String(process.env.APP_URL || '').trim())
    return (
      target.origin === appUrl.origin &&
      String(target.pathname || '').startsWith('/media/r2/media/')
    )
  } catch {
    return false
  }
}

function isAllowedProxyTarget(target) {
  return isAllowedMediaUrl(target) || isOwnPublicUploadUrl(target)
}

/**
 * Content-Type para resposta do proxy.
 * 1) Upstream específico → mantém
 * 2) Upstream genérico + magic bytes de áudio → CT correto (OGG/M4A/MP3/WebM…)
 * 3) Senão → filename/URL (comportamento anterior)
 * 4) Senão → octet-stream
 *
 * @param {string|null} upstreamCt
 * @param {string} urlStr
 * @param {string} filename
 * @param {Buffer} [buffer]
 */
function resolveContentType(upstreamCt, urlStr, filename, buffer) {
  const ct = String(upstreamCt || '').trim().split(';')[0].trim()
  const isGeneric = GENERIC_CONTENT_TYPES.has(ct.toLowerCase())
  if (!isGeneric) return ct

  // Bytes reais primeiro — UltraMSG/S3 costuma mandar octet-stream sem extensão no path.
  if (buffer) {
    const fromBytes = contentTypeFromAudioMagicBytes(buffer)
    if (fromBytes) return fromBytes
  }

  // Fallback idêntico ao comportamento anterior (filename → path da URL → genérico).
  const fromFilename = mimeFromFilename(filename)
  if (fromFilename) return fromFilename

  const fromUrl = mimeFromFilename(filenameFromUrlPath(urlStr))
  if (fromUrl) return fromUrl

  return ct || 'application/octet-stream'
}

async function fetchAllowedMedia(target, signal) {
  let current = target
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const upstream = await fetch(current.href, {
      redirect: 'manual',
      headers: { 'User-Agent': 'ZapERP-MediaProxy/1.0' },
      signal,
    })

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      if (!location) return upstream
      const next = new URL(location, current)
      if (!isAllowedProxyTarget(next)) {
        const err = new Error('redirect_not_allowed')
        err.code = 'REDIRECT_NOT_ALLOWED'
        throw err
      }
      current = next
      continue
    }

    return upstream
  }

  const err = new Error('too_many_redirects')
  err.code = 'TOO_MANY_REDIRECTS'
  throw err
}

/** Download do upstream com timeout; nunca lança (retorna { ok:false } com status/erro). */
async function baixarCorpoUpstream(target) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const upstream = await fetchAllowedMedia(target, controller.signal)
    if (!upstream.ok) {
      return { ok: false, httpStatus: 502, error: 'Mídia indisponível na origem' }
    }
    const cl = Number(upstream.headers.get('content-length') || 0)
    if (Number.isFinite(cl) && cl > MAX_BYTES) {
      return { ok: false, httpStatus: 413, error: 'Arquivo muito grande' }
    }
    const arrayBuffer = await upstream.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return { ok: false, httpStatus: 413, error: 'Arquivo muito grande' }
    }
    return { ok: true, body: Buffer.from(arrayBuffer), upstreamCt: upstream.headers.get('content-type') || '' }
  } catch (e) {
    const timedOut = e?.name === 'AbortError'
    console.error('[mediaProxy] fetch:', timedOut ? 'timeout' : (e?.message || e))
    return { ok: false, httpStatus: 502, error: 'Não foi possível obter a mídia' }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Corpo proxiado com cache + dedupe de voo: pedidos concorrentes da mesma URL (duplo load,
 * Range da sonda de duração, recarga do vigia) compartilham UM download do provedor.
 * Falha não é cacheada — a próxima tentativa volta ao upstream.
 */
async function obterCorpoProxiado(target, cacheKey) {
  if (cacheDisabled() || !cacheKey) return baixarCorpoUpstream(target)
  const hit = cacheGet(cacheKey)
  if (hit) return { ok: true, body: hit.body, upstreamCt: hit.ct, fromCache: true }
  const emVoo = _inflight.get(cacheKey)
  if (emVoo) return emVoo
  const p = baixarCorpoUpstream(target)
    .then((r) => {
      if (r.ok) cachePut(cacheKey, r.body, r.upstreamCt)
      return r
    })
    .finally(() => {
      _inflight.delete(cacheKey)
    })
  _inflight.set(cacheKey, p)
  return p
}

/**
 * GET /media/proxy?url=<https...>[&filename=<nome>[&disposition=attachment|inline]]
 * Requer JWT (middleware auth na rota).
 *
 * - filename : nome a usar no Content-Disposition (ex.: contrato.pdf)
 * - disposition: forçar "attachment" (download) ou "inline" (exibir no browser).
 *               Se omitido, usa "inline" para imagens/vídeos/áudio/PDF, "attachment" para o resto.
 */
exports.proxyMedia = async (req, res) => {
  const raw = req.query.url
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Parâmetro url obrigatório' })
  }

  // filename pode vir na query ou ser derivado da URL upstream
  const filenameParam = req.query.filename ? String(req.query.filename).trim() : ''
  const dispositionParam = req.query.disposition ? String(req.query.disposition).trim().toLowerCase() : ''

  let target
  try {
    target = unwrapNestedProxyTarget(raw)
  } catch {
    return res.status(400).json({ error: 'URL inválida' })
  }

  // Chave do cache SEMPRE pela URL canônica pedida (antes do presign do R2, cuja assinatura
  // muda a cada requisição — senão cada pedido R2 seria um "miss" e um novo download).
  let cacheKey = target.href

  // Mídia própria migrada ao R2 (APP_URL/media/r2/<key>): gera a URL assinada do R2 e serve dela
  // direto — assim áudio/mídia que o frontend pede via proxy funciona igual funcionava com /uploads.
  let trustedTarget = false
  if (isOwnR2DeliveryUrl(target)) {
    try {
      const key = decodeURIComponent(String(target.pathname).replace(/^\/media\/r2\//, '').split('?')[0])
      if (key.includes('..') || !key.startsWith('media/')) {
        return res.status(400).json({ error: 'Chave de mídia inválida' })
      }
      const { presignGetUrl } = require('../services/storage/r2Client')
      const { getPresignExpiresSeconds } = require('../config/r2')
      target = new URL(presignGetUrl(key, getPresignExpiresSeconds()))
      trustedTarget = true
    } catch (e) {
      console.error('[mediaProxy] presign R2 falhou:', e?.message || e)
      return res.status(502).json({ error: 'Não foi possível acessar a mídia' })
    }
  }

  if (!trustedTarget && !isAllowedProxyTarget(target)) {
    console.warn('[mediaProxy] URL bloqueada (403):', {
      host: target.hostname,
      path: String(target.pathname || '').slice(0, 80),
    })
    return res.status(403).json({ error: 'Origem não permitida' })
  }

  const resultado = await obterCorpoProxiado(target, cacheKey)
  if (!resultado.ok) {
    return res.status(resultado.httpStatus || 502).json({ error: resultado.error || 'Não foi possível obter a mídia' })
  }

  {
    const body = resultado.body
    // Resolve Content-Type: upstream específico, senão magic bytes (áudio), senão filename/URL.
    const ct = resolveContentType(
      resultado.upstreamCt,
      target.href,
      filenameParam,
      body
    )

    // Resolve filename para o Content-Disposition
    const effectiveFilename = filenameParam || filenameFromUrlPath(target.href)

    // Decide disposition: inline para mídia/PDF (abre no browser), attachment para o resto
    let dispositionType
    if (dispositionParam === 'attachment' || dispositionParam === 'inline') {
      dispositionType = dispositionParam
    } else {
      const isInline =
        INLINE_MIME_PREFIXES.some((p) => ct.startsWith(p)) ||
        INLINE_MIME_EXACT.has(ct)
      dispositionType = isInline ? 'inline' : 'attachment'
    }

    res.setHeader('Content-Type', ct)
    // max-age=86400: 24h cobrem o TTL típico das URLs do provedor (UltraMsg/S3).
    // immutable: o nome do arquivo em /uploads inclui hex aleatório — o conteúdo nunca muda.
    // res.end() em vez de res.send(): res.send adiciona ETag FRACO, que colide com a entrada
    // "sparse" de mídia do Chrome (ERR_CACHE_OPERATION_NOT_SUPPORTED visto em /uploads antes).
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable')
    res.setHeader('Accept-Ranges', 'bytes')

    // RFC 5987: nome real em filename*; `filename=` só ASCII. Antes o nome cru ia no header e
    // "Relatório — final.pdf" / emoji (> U+00FF) lançava ERR_INVALID_CHAR → 502 ao abrir/salvar.
    const safeFilename = effectiveFilename ? sanitizeDownloadFilename(effectiveFilename) : null
    if (safeFilename) {
      res.setHeader('Content-Disposition', buildContentDisposition(dispositionType, safeFilename))
    }

    const total = body.length
    const rangeHeader = req.headers['range']
    if (rangeHeader) {
      const range = parseSingleByteRange(rangeHeader, total)
      if (!range) {
        // Intervalo inválido ou fora do arquivo — RFC 7233 §4.4
        res.setHeader('Content-Range', `bytes */${total}`)
        return res.status(416).end()
      }
      const { start, end } = range
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
      res.setHeader('Content-Length', String(end - start + 1))
      return res.status(206).end(body.slice(start, end + 1))
    }

    res.setHeader('Content-Length', String(total))
    return res.status(200).end(body)
  }
}

/**
 * Parseia um único intervalo byte-range da forma definida em RFC 7233 §2.1.
 * Suporta: bytes=a-b, bytes=a-, bytes=-n.
 * Retorna { start, end } (ambos inclusivos) ou null para intervalo inválido/multi-range.
 * Nunca retorna um intervalo fora de [0, totalLength-1].
 */
function parseSingleByteRange(rangeHeader, totalLength) {
  if (!rangeHeader || !String(rangeHeader).startsWith('bytes=')) return null
  const spec = String(rangeHeader).slice(6).trim()
  if (spec.includes(',')) return null // multi-range não implementado
  const m = spec.match(/^(\d*)-(\d*)$/)
  if (!m) return null
  const [, startStr, endStr] = m
  if (startStr === '' && endStr === '') return null
  let start, end
  if (startStr === '') {
    const suffix = parseInt(endStr, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, totalLength - suffix)
    end = totalLength - 1
  } else {
    start = parseInt(startStr, 10)
    end = endStr === '' ? totalLength - 1 : parseInt(endStr, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start > end || end >= totalLength) return null
  return { start, end }
}

/** Helpers puros para testes de regressão (não alteram o fluxo HTTP). */
exports._test = {
  resolveContentType,
  mimeFromFilename,
  filenameFromUrlPath,
  parseSingleByteRange,
  unwrapNestedProxyTarget,
  isOwnPublicUploadUrl,
  isOwnR2DeliveryUrl,
  isAllowedProxyTarget,
  cacheGet,
  cachePut,
  resetMediaProxyCache,
  obterCorpoProxiado,
}
