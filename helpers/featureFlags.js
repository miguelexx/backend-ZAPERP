/**
 * Feature flags via ENV.
 * Permite ativar/desativar módulos sem alterar código.
 * Valores: '1', 'true', 'yes' = ativo; qualquer outro = inativo.
 */
function isEnabled(flag) {
  const v = String(process.env[flag] || '').toLowerCase().trim()
  return v === '1' || v === 'true' || v === 'yes'
}

const FLAGS = {
  FEATURE_CAMPANHAS: 'FEATURE_CAMPANHAS',
  FEATURE_PROTECAO: 'FEATURE_PROTECAO',
  FEATURE_REGRA_AUTO_WEBHOOK: 'FEATURE_REGRA_AUTO_WEBHOOK',
  FEATURE_OPT_OUT_WEBHOOK: 'FEATURE_OPT_OUT_WEBHOOK',
  FEATURE_METRICAS_AVANCADAS: 'FEATURE_METRICAS_AVANCADAS',
}

module.exports = { isEnabled, FLAGS }
