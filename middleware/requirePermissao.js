'use strict'

const { usuarioTemPermissao } = require('../helpers/permissoesService')

/**
 * Exige permissao granular no backend (override + padrao do perfil).
 * Admin sempre passa via usuarioTemPermissao.
 */
function requirePermissao(codigo) {
  return async (req, res, next) => {
    try {
      const user = req.user || {}
      const ok = await usuarioTemPermissao({
        usuario_id: user.id,
        company_id: user.company_id,
        perfil: user.perfil,
        permissao_codigo: codigo,
      })
      if (!ok) {
        return res.status(403).json({ error: 'Sem permissão para esta ação' })
      }
      return next()
    } catch (e) {
      console.error('[requirePermissao]', codigo, e?.message || e)
      return res.status(500).json({ error: 'Erro interno' })
    }
  }
}

module.exports = requirePermissao
