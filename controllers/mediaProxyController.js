/**
 * Proxy server-side de URLs de mídia (ex.: S3 UltraMsg) para o frontend poder
 * baixar bytes com autenticação sem depender de CORS no bucket externo.
 */

const { isAllowedInboundMediaUrl: isAllowedMediaUrl } = require('../helpers/allowedInboundMediaUrl')

const MAX_BYTES = 80 * 1024 * 1024 // 80 MB (impressão / preview)

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
