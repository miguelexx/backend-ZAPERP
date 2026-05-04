/**
 * Proxy server-side de URLs de mídia (ex.: S3 UltraMsg) para o frontend poder
 * baixar bytes com autenticação sem depender de CORS no bucket externo.
 */

const MAX_BYTES = 80 * 1024 * 1024 // 80 MB (impressão / preview)

/**
 * @param {URL} u
 * @returns {boolean}
 */
function isAllowedMediaUrl(u) {
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^169\.254\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    return false
  }

  if (host.endsWith('.amazonaws.com')) {
    const path = u.pathname
    if (path.includes('/ultramsgmedia/')) return true
    if (host.startsWith('ultramsgmedia.')) return true
    return false
  }

  const extra = String(process.env.MEDIA_PROXY_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (extra.length && extra.includes(host)) return true

  return false
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

  let upstream
  try {
    upstream = await fetch(target.href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'ZapERP-MediaProxy/1.0' },
    })
  } catch (e) {
    console.error('[mediaProxy] fetch:', e?.message || e)
    return res.status(502).json({ error: 'Não foi possível obter a mídia' })
  }

  if (!upstream.ok) {
    return res.status(502).json({ error: 'Mídia indisponível na origem' })
  }

  const cl = upstream.headers.get('content-length')
  if (cl && Number(cl) > MAX_BYTES) {
    return res.status(413).json({ error: 'Arquivo muito grande' })
  }

  const arrayBuffer = await upstream.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_BYTES) {
    return res.status(413).json({ error: 'Arquivo muito grande' })
  }

  const ct = upstream.headers.get('content-type') || 'application/octet-stream'
  res.setHeader('Content-Type', ct)
  res.setHeader('Cache-Control', 'private, max-age=120')
  return res.status(200).send(Buffer.from(arrayBuffer))
}
