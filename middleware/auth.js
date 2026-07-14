const jwt = require('jsonwebtoken')
const { usuarioEstaAtivo } = require('../helpers/usuarioAtivoGuard')

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    return res.status(401).json({ error: 'Token não informado' })
  }

  const [scheme, token] = authHeader.split(' ')

  if (!/^Bearer$/i.test(scheme) || !token) {
    return res.status(401).json({ error: 'Token mal formatado' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' })
  }

  try {
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

    // Revogação: usuário desativado (soft-delete) não mantém acesso pelo JWT de 30d.
    // Fail-open no helper: erro de banco nunca bloqueia; cache curto evita query por request.
    const ativo = await usuarioEstaAtivo(decoded?.id ?? decoded?.user_id, cid)
    if (!ativo) {
      return res.status(401).json({ error: 'Usuário inativo' })
    }

    decoded.company_id = cid
    // Múltiplos departamentos: garantir departamento_ids (compat com tokens antigos)
    if (!Array.isArray(decoded.departamento_ids)) {
      decoded.departamento_ids = decoded.departamento_id != null ? [Number(decoded.departamento_id)] : []
    }
    req.user = decoded
    return next()
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' })
  }
}
