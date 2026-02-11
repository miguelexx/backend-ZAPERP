/** Middleware: apenas admin pode acessar */
module.exports = (req, res, next) => {
  const perfil = req.user?.perfil || ''
  if (String(perfil).toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' })
  }
  next()
}
