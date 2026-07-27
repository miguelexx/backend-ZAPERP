const { sanitizeRequestUrl } = require('../helpers/sanitizeRequestUrl')

module.exports = (req, res, next) => {
  const start = Date.now()

  res.on('finish', () => {
    const ms = Date.now() - start
    const safeUrl = sanitizeRequestUrl(req.originalUrl || req.url || '')
    console.log(
      `[${req.requestId || '-'}] ${req.method} ${safeUrl} ${res.statusCode} ${ms}ms user:${req.user?.id || '-'} ip:${req.ip || '-'}`
    )
  })

  next()
}
