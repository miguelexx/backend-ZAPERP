module.exports = (req, res, next) => {
  const start = Date.now()

  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(
      `[${req.requestId || '-'}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms user:${req.user?.id || '-'} ip:${req.ip || '-'}`
    )
  })

  next()
}
