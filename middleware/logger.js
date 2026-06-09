const crypto = require('crypto')

module.exports = (req, res, next) => {
  const id = crypto.randomUUID()
  const start = Date.now()

  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(
      `[${id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms user:${req.user?.id || '-'}`
    )
  })

  next()
}
