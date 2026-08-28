/**
 * Saúde operacional do Disparo (Etapa 9) — admin-only via disparoRoutes.
 * Nunca expõe tokens ou secrets.
 */

const { snapshotSaudeDisparo } = require('../helpers/disparoObservabilidade')

function getCompanyId(req) {
  return Number(req.user?.company_id)
}

exports.obterSaude = async (req, res) => {
  try {
    const companyId = getCompanyId(req)
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: 'company_id inválido no token.' })
    }

    const snapshot = await snapshotSaudeDisparo(companyId)

    res.json({
      ok: true,
      ...snapshot,
    })
  } catch (err) {
    console.error('[disparo:saude] obterSaude', err)
    res.status(500).json({ error: 'Erro ao consultar saúde do Disparo.' })
  }
}
