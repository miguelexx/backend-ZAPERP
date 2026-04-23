const { empresaCrmHabilitada } = require('../helpers/crmEmpresaFlag')

/**
 * Bloqueia rotas /crm quando o administrador desativou o módulo na empresa.
 */
module.exports = async function requireCrmHabilitado(req, res, next) {
  try {
    const company_id = req.user?.company_id
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const ok = await empresaCrmHabilitada(company_id)
    if (!ok) {
      return res.status(403).json({
        error: 'Módulo CRM desativado para esta empresa.',
        code: 'CRM_DISABLED',
      })
    }
    return next()
  } catch (e) {
    console.error('[requireCrmHabilitado]', e?.message || e)
    return res.status(500).json({ error: 'Erro ao verificar configuração do CRM' })
  }
}
