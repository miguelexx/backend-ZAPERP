/**
 * Middleware: exige que o usuário tenha a permissão especificada.
 * Se não tiver, retorna 403.
 *
 * Uso: router.get('/rota', auth, hasPermission('config.editar'), controller.fn)
 *
 * Considera: 1) override em usuario_permissoes, 2) padrão do perfil.
 * Admin sempre passa.
 */
const { usuarioTemPermissao } = require('../helpers/permissoesService')

/**
 * @param {string} permissaoCodigo - Ex: 'config.editar', 'usuarios.criar'
 * @returns {Function} Express middleware
 */
function hasPermission(permissaoCodigo) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' })
    }
    const { id: user_id, company_id, perfil } = req.user
    if (perfil === 'admin') return next()

    const tem = await usuarioTemPermissao({
      usuario_id: user_id,
      company_id,
      perfil,
      permissao_codigo: permissaoCodigo
    })
    if (!tem) {
      return res.status(403).json({ error: 'Sem permissão para esta ação' })
    }
    next()
  }
}

module.exports = hasPermission
