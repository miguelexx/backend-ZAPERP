/**
 * Middleware: apenas administrador pode acessar.
 * Níveis: atendente | supervisor | admin
 */
module.exports = (req, res, next) => {
  const perfil = String(req.user?.perfil || '').toLowerCase()
  if (perfil !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' })
  }
  next()
}
