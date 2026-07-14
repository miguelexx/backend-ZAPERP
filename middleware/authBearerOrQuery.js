const jwt = require('jsonwebtoken')
const { usuarioEstaAtivo } = require('../helpers/usuarioAtivoGuard')

/** JWT via Authorization Bearer ou ?access_token= (tags <video>/<img> sem header). */
module.exports = async (req, res, next) => {
  let token = null
  const authHeader = req.headers.authorization
  if (authHeader) {
    const [scheme, t] = authHeader.split(' ')
    if (/^Bearer$/i.test(scheme) && t) token = t.trim()
  }
  if (!token) {
    const q = req.query?.access_token ?? req.query?.token
    if (q && typeof q === 'string') token = q.trim()
  }
  if (!token) {
    return res.status(401).json({ error: 'Token não informado' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Token inválido' })
  }

  try {
    const cid = Number(decoded?.company_id)
    if (!Number.isFinite(cid) || cid <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }
    // Revogação: mesmo critério do middleware auth (usuário desativado não acessa mídia).
    const ativo = await usuarioEstaAtivo(decoded?.id ?? decoded?.user_id, cid)
    if (!ativo) {
      return res.status(401).json({ error: 'Usuário inativo' })
    }
    decoded.company_id = cid
    if (!Array.isArray(decoded.departamento_ids)) {
      decoded.departamento_ids = decoded.departamento_id != null ? [Number(decoded.departamento_id)] : []
    }
    req.user = decoded
    return next()
  } catch {
    return res.status(401).json({ error: 'Token inválido' })
  }
}
