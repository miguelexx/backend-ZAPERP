/**
 * Proxy server-side de URLs de mídia (ex.: S3 UltraMsg) para o frontend poder
 * baixar bytes com autenticação sem depender de CORS no bucket externo.
 */

const { isAllowedInboundMediaUrl: isAllowedMediaUrl } = require('../helpers/allowedInboundMediaUrl')

const MAX_BYTES = 80 * 1024 * 1024 // 80 MB (impressão / preview)
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.MEDIA_PROXY_TIMEOUT_MS) || 30000)
const MAX_REDIRECTS = 3

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
 * GET /media/proxy?url=<https...>
 * Requer JWT (middleware auth na rota).
 */
exports.proxyMedia = async (req, res) => {
  const raw = req.query.url
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Parâmetro url obrigatório' })
  }

  let target
  try {
    target = new URL(raw)
  } catch {
    return res.status(400).json({ error: 'URL inválida' })
  }

  if (!isAllowedMediaUrl(target)) {
    return res.status(403).json({ error: 'Origem não permitida' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const upstream = await fetchAllowedMedia(target, controller.signal)

    if (!upstream.ok) {
      return res.status(502).json({ error: 'Mídia indisponível na origem' })
    }

    const cl = Number(upstream.headers.get('content-length') || 0)
    if (Number.isFinite(cl) && cl > MAX_BYTES) {
      return res.status(413).json({ error: 'Arquivo muito grande' })
    }

    const arrayBuffer = await upstream.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: 'Arquivo muito grande' })
    }

    let ct = upstream.headers.get('content-type') || 'application/octet-stream'
    const pathLower = String(target.pathname || '').toLowerCase()
    if ((!ct || ct === 'application/octet-stream') && /\.(mp4|mov|webm|3gp|m4v|mkv)(\?|$)/i.test(pathLower)) {
      ct = 'video/mp4'
    }
    res.setHeader('Content-Type', ct)
    res.setHeader('Cache-Control', 'private, max-age=120')
    res.setHeader('Accept-Ranges', 'bytes')
    return res.status(200).send(Buffer.from(arrayBuffer))
  } catch (e) {
    const timedOut = e?.name === 'AbortError'
    console.error('[mediaProxy] fetch:', timedOut ? 'timeout' : (e?.message || e))
    return res.status(502).json({ error: 'Não foi possível obter a mídia' })
  } finally {
    clearTimeout(timeout)
  }
}
