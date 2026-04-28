/**
 * Middleware: supervisor ou admin pode acessar.
 * Atendente não tem permissão.
 * Níveis: atendente < supervisor < admin
 */
module.exports = (req, res, next) => {
  const perfil = String(req.user?.perfil || '').toLowerCase()
  if (perfil === 'admin' || perfil === 'administrador' || perfil === 'supervisor') {
    return next()
  }
  return res.status(403).json({ error: 'Acesso restrito a supervisores ou administradores' })
}
