const { redactedRequestUrl } = require('../helpers/redactUrlSecrets')

module.exports = (req, res, next) => {
  const start = Date.now()

  res.on('finish', () => {
    const ms = Date.now() - start
    // URL redigida: `?token=` do webhook UltraMSG e o JWT de `/media/proxy` NÃO vão para o log
    // (doc 33, F1). Nunca voltar para `req.originalUrl` cru aqui.
    console.log(
      `[${req.requestId || '-'}] ${req.method} ${redactedRequestUrl(req)} ${res.statusCode} ${ms}ms user:${req.user?.id || '-'} ip:${req.ip || '-'}`
    )
  })

  next()
}
