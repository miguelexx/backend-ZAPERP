/**
 * Proxy server-side de URLs de mídia (ex.: S3 UltraMsg) para o frontend poder
 * baixar bytes com autenticação sem depender de CORS no bucket externo.
 */

const { isAllowedInboundMediaUrl: isAllowedMediaUrl } = require('../helpers/allowedInboundMediaUrl')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const BUFFER_MAX_BYTES = Math.max(
  1024 * 1024,
  (Number(process.env.MEDIA_PROXY_BUFFER_MAX_MB) || 80) * 1024 * 1024
)
const MAX_BYTES = Math.max(
  BUFFER_MAX_BYTES,
  (Number(process.env.MEDIA_PROXY_MAX_MB) || 512) * 1024 * 1024
)
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MEDIA_PROXY_TIMEOUT_MS) || 30000)
const MAX_REDIRECTS = 3

/** Mapa extensão → MIME type. Cobre os formatos mais comuns do ZapERP. */
const MIME_BY_EXT = {
  // Imagens
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
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
  mpeg: 'video/mpeg',
  mpg:  'video/mpeg',
  // Áudio
  mp3:  'audio/mpeg',
  m4a:  'audio/mp4',
  ogg:  'audio/ogg',
  opus: 'audio/ogg',
  wav:  'audio/wav',
  aac:  'audio/aac',
  amr:  'audio/amr',
  flac: 'audio/flac',
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
  rtf:  'application/rtf',
  odt:  'application/vnd.oasis.opendocument.text',
  ods:  'application/vnd.oasis.opendocument.spreadsheet',
  odp:  'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  // Compactados
  zip:  'application/zip',
  rar:  'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
}

const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/']
const INLINE_MIME_EXACT = new Set(['application/pdf'])

/**
 * Monta Content-Disposition sem colocar Unicode/controles diretamente no header HTTP.
 *
 * Nomes recebidos do WhatsApp podem conter emoji, acentos e até caracteres de controle.
 * O Node rejeita esses valores em setHeader (ERR_INVALID_CHAR), o que antes transformava
 * um arquivo válido em 502. O filename ASCII é apenas fallback; filename* preserva UTF-8.
 */
function buildContentDisposition(dispositionType, filename) {
  const basename = String(filename || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/[\\/]/)
    .pop()
    .trim()
  if (!basename) return ''

  // Buffer normaliza eventuais surrogate code points isolados para U+FFFD.
  const unicodeName = Array.from(Buffer.from(basename, 'utf8').toString('utf8'))
    .slice(0, 180)
    .join('')
  const asciiFallback =
    unicodeName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'download'
  const encoded = encodeURIComponent(unicodeName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

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

/**
 * Interpreta o header Range para um corpo já carregado em memória.
 * Só suporta a forma de um único intervalo (`bytes=a-b`, `bytes=a-`, `bytes=-n`),
 * que é a única que <audio>/<video> usam.
 * @returns {{ start: number, end: number } | null} null = servir o corpo inteiro (200)
 *          | 'invalid' = intervalo fora do arquivo (416)
 */
function parseSingleByteRange(rangeHeader, size) {
  const raw = String(rangeHeader || '').trim()
  if (!raw || size <= 0) return null
  const m = raw.match(/^bytes=(\d*)-(\d*)$/i)
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null

  let start
  let end
  if (!hasStart) {
    // sufixo: últimos N bytes
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = hasEnd ? Number(m[2]) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
    if (end > size - 1) end = size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
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

/**
 * Garante que o Content-Type não seja genérico quando temos a extensão disponível.
 * Retorna o MIME original se já for específico, ou o derivado da extensão.
 */
function resolveContentType(upstreamCt, urlStr, filename) {
  const ct = String(upstreamCt || '').trim().split(';')[0].trim()
  const isGeneric = !ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream'
  if (!isGeneric) return ct

  // Tenta resolver pelo filename do parâmetro (maior prioridade)
  const fromFilename = mimeFromFilename(filename)
  if (fromFilename) return fromFilename

  // Tenta resolver pela extensão no path da URL upstream
  const fromUrl = mimeFromFilename(filenameFromUrlPath(urlStr))
  if (fromUrl) return fromUrl

  return ct || 'application/octet-stream'
}

async function fetchAllowedMedia(target, signal, rangeHeader = '') {
  let current = target
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const upstream = await fetch(current.href, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'ZapERP-MediaProxy/1.0',
        // Repassa o Range: o S3/CDN da origem responde 206 com só a fatia pedida, então
        // um seek do player não obriga o servidor a baixar o arquivo inteiro de novo.
        // Se a origem ignorar e devolver 200, o fatiamento local abaixo cobre.
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      signal,
    })

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      if (!location) return upstream
      const next = new URL(location, current)
      if (!isAllowedMediaUrl(next)) {
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
    target = new URL(raw)
  } catch {
    return res.status(400).json({ error: 'URL inválida' })
  }

  if (!isAllowedMediaUrl(target)) {
    console.warn('[mediaProxy] URL bloqueada (403):', {
      host: target.hostname,
      path: String(target.pathname || '').slice(0, 80),
    })
    return res.status(403).json({ error: 'Origem não permitida' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const clientRange = String(req.headers.range || '').trim()

  try {
    const upstream = await fetchAllowedMedia(target, controller.signal, clientRange)

    if (!upstream.ok) {
      // 416 da origem é resposta legítima a um Range fora do arquivo — repassar em vez de virar 502.
      if (upstream.status === 416) {
        const cr = String(upstream.headers.get('content-range') || '').trim()
        if (cr) res.setHeader('Content-Range', cr)
        res.setHeader('Accept-Ranges', 'bytes')
        return res.status(416).end()
      }
      return res.status(502).json({ error: 'Mídia indisponível na origem' })
    }

    const cl = Number(upstream.headers.get('content-length') || 0)
    if (Number.isFinite(cl) && cl > MAX_BYTES) {
      return res.status(413).json({ error: 'Arquivo muito grande' })
    }

    // Resolve Content-Type: prioriza upstream específico; fallback por extensão do filename/URL
    const ct = resolveContentType(
      upstream.headers.get('content-type'),
      target.href,
      filenameParam
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
    // Os bytes de uma URL de mídia do provedor nunca mudam, então vale cache longo:
    // com max-age curto o <audio> revalidava no meio da reprodução e o áudio "travava"
    // até recarregar a página.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable')
    res.setHeader('Accept-Ranges', 'bytes')

    if (effectiveFilename) {
      const contentDisposition = buildContentDisposition(dispositionType, effectiveFilename)
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition)
    }

    // Documentos grandes não podem ser materializados num único Buffer: além de impedir
    // arquivos acima do antigo teto de 80 MB, isso multiplicava o uso de memória do processo.
    // Quando a origem informa o tamanho, transmite diretamente para o navegador. Pedidos Range
    // honrados pela origem também podem seguir por streaming sem perder Content-Range.
    const canStreamUpstream =
      cl > BUFFER_MAX_BYTES &&
      upstream.body &&
      typeof upstream.body.getReader === 'function' &&
      (!clientRange || upstream.status === 206)

    if (canStreamUpstream) {
      if (clientRange && upstream.status === 206) {
        const upstreamRange = String(upstream.headers.get('content-range') || '').trim()
        if (!upstreamRange) {
          console.warn('[mediaProxy] origem devolveu 206 sem Content-Range:', target.hostname)
          return res.status(502).json({ error: 'Resposta parcial inválida da origem' })
        }
        res.setHeader('Content-Range', upstreamRange)
        res.status(206)
      } else {
        res.status(200)
      }
      res.setHeader('Content-Length', String(cl))

      // O timeout protege a obtenção dos headers. Depois que o download começou, abortá-lo
      // aos 30 s quebraria anexos grandes em conexões mais lentas.
      clearTimeout(timeout)
      await pipeline(Readable.fromWeb(upstream.body), res)
      return
    }

    const arrayBuffer = await upstream.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: 'Arquivo muito grande' })
    }

    const body = Buffer.from(arrayBuffer)

    // Range: <audio>/<video> pedem intervalos para tocar, buscar (seek) e retomar depois do
    // cache expirar. Antes anunciávamos "Accept-Ranges: bytes" mas respondíamos sempre 200 com
    // o arquivo inteiro; o navegador trata isso como erro de mídia e o player fica travado até
    // recarregar a página. Agora respondemos 206 + Content-Range de verdade.
    // Respondemos com res.end (e não res.send) de propósito: res.send anexa um ETag FRACO,
    // e ETag fraco não pode revalidar uma entrada de cache "sparse" (a que o Chrome cria para
    // mídia baixada por Range) — foi essa combinação que gerou ERR_CACHE_OPERATION_NOT_SUPPORTED
    // em /uploads. Sem ETag + immutable não há revalidação nenhuma.

    // A origem honrou o Range: já temos exatamente a fatia pedida, é só repassar o Content-Range
    // dela (recalcular localmente daria offsets errados, porque `body` aqui é só o pedaço).
    if (clientRange && upstream.status === 206) {
      const upstreamRange = String(upstream.headers.get('content-range') || '').trim()
      if (!upstreamRange) {
        // 206 sem Content-Range viola o protocolo e deixa o offset indeterminado. Fatiar de novo
        // entregaria bytes errados e devolver como 200 mentiria sobre ser o arquivo completo —
        // nos dois casos o áudio sairia corrompido. Falhar é a única saída honesta.
        console.warn('[mediaProxy] origem devolveu 206 sem Content-Range:', target.hostname)
        return res.status(502).json({ error: 'Resposta parcial inválida da origem' })
      }
      res.setHeader('Content-Range', upstreamRange)
      res.setHeader('Content-Length', String(body.length))
      return res.status(206).end(body)
    }

    const range = parseSingleByteRange(clientRange, body.length)
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${body.length}`)
      return res.status(416).end()
    }
    if (range) {
      const slice = body.subarray(range.start, range.end + 1)
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`)
      res.setHeader('Content-Length', String(slice.length))
      return res.status(206).end(slice)
    }

    res.setHeader('Content-Length', String(body.length))
    return res.status(200).end(body)
  } catch (e) {
    const timedOut = e?.name === 'AbortError'
    console.error('[mediaProxy] fetch:', timedOut ? 'timeout' : (e?.message || e))
    if (res.headersSent) {
      res.destroy(e)
      return
    }
    return res.status(502).json({ error: 'Não foi possível obter a mídia' })
  } finally {
    clearTimeout(timeout)
  }
}

exports.parseSingleByteRange = parseSingleByteRange
exports.buildContentDisposition = buildContentDisposition
