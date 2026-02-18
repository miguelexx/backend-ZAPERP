const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    return res.status(401).json({ error: 'Token não informado' })
  }

  const [scheme, token] = authHeader.split(' ')

  if (!/^Bearer$/i.test(scheme)) {
    return res.status(401).json({ error: 'Token mal formatado' })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    // =========================================================
    // 🔒 Multi-tenant estrito: company_id é obrigatório no token
    // =========================================================
    const cid = Number(decoded?.company_id)
    if (!Number.isFinite(cid) || cid <= 0) {
      console.error('[TENANT_INCONSISTENT] Token sem company_id válido', {
        path: req.originalUrl,
        method: req.method,
        user_id: decoded?.id ?? null,
        company_id: decoded?.company_id ?? null,
        ip: req.ip
      })
      return res.status(401).json({ error: 'Tenant inválido' })
    }

    decoded.company_id = cid
    req.user = decoded
    return next()
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' })
  }
}
