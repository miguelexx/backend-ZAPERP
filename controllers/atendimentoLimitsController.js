const {
  getAtendimentoLimitsConfig,
  saveCompanyLimitsConfig,
  saveUserLimitsConfig,
  DEFAULT_LIMIT_CONFIG,
} = require('../services/atendimentoLimitsService')

exports.getConfig = async (req, res) => {
  try {
    const companyId = Number(req.user?.company_id)
    const config = await getAtendimentoLimitsConfig(companyId)
    return res.json({
      ...config,
      defaults: DEFAULT_LIMIT_CONFIG,
    })
  } catch (error) {
    console.error('[atendimentoLimits] getConfig:', error?.message || error)
    return res.status(500).json({ error: 'Erro ao carregar limites de atendimento.' })
  }
}

exports.putCompanyConfig = async (req, res) => {
  try {
    const companyId = Number(req.user?.company_id)
    const adminId = Number(req.user?.id ?? req.user?.user_id)
    await saveCompanyLimitsConfig(companyId, adminId, req.body || {})
    const config = await getAtendimentoLimitsConfig(companyId)
    return res.json({
      ...config,
      defaults: DEFAULT_LIMIT_CONFIG,
    })
  } catch (error) {
    console.error('[atendimentoLimits] putCompanyConfig:', error?.message || error)
    return res.status(500).json({ error: 'Erro ao salvar limites de atendimento.' })
  }
}

exports.putUserConfig = async (req, res) => {
  try {
    const companyId = Number(req.user?.company_id)
    const adminId = Number(req.user?.id ?? req.user?.user_id)
    const usuarioId = Number(req.params.usuario_id)
    if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
      return res.status(400).json({ error: 'usuario_id invalido.' })
    }

    await saveUserLimitsConfig(companyId, adminId, usuarioId, req.body || {})
    const config = await getAtendimentoLimitsConfig(companyId)
    return res.json({
      ...config,
      defaults: DEFAULT_LIMIT_CONFIG,
    })
  } catch (error) {
    console.error('[atendimentoLimits] putUserConfig:', error?.message || error)
    return res.status(500).json({ error: 'Erro ao salvar limite do usuario.' })
  }
}
