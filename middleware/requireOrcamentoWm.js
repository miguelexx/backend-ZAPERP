const orcamentoWmFlag = require('../helpers/orcamentoWmFlag')

const NEGADO = {
  error: 'Módulo de Orçamento (ERP) indisponível para esta empresa.',
  code: 'ORCAMENTO_WM_OFF',
}

/**
 * Bloqueia as rotas de orçamento WM quando o módulo não está ligado para a empresa
 * (env global `WM_ORCAMENTOS_ENABLED` E `wm_orcamento_integracoes.ativo`).
 *
 * Espelha `middleware/requireModuloCampanhas.js`. Fail-closed: erro de leitura da flag = 403.
 * A mensagem não distingue "env desligada" de "empresa desativada" nem de "falha de leitura" —
 * o atendente não precisa saber, e a distinção vazaria configuração de ambiente.
 */
module.exports = async function requireOrcamentoWm(req, res, next) {
  try {
    const habilitado = await orcamentoWmFlag.orcamentoWmHabilitado(req.user?.company_id)
    if (!habilitado) return res.status(403).json(NEGADO)
    return next()
  } catch (err) {
    console.error('[requireOrcamentoWm]', err?.message || err)
    return res.status(403).json(NEGADO)
  }
}
