const moduloCampanhas = require('../helpers/moduloCampanhas')

/**
 * Bloqueia rotas /disparo quando a empresa não ativou o módulo Campanhas.
 * Fail-closed: erro de leitura da flag = 403.
 */
module.exports = async function requireModuloCampanhas(req, res, next) {
  try {
    const ativo = await moduloCampanhas.empresaModuloCampanhasAtivo(req.user?.company_id)
    if (!ativo) {
      return res.status(403).json({
        error: 'Módulo Campanhas desativado. Ative em Configurações gerais com a senha de ativação.',
        code: 'MODULO_CAMPANHAS_OFF',
      })
    }
    return next()
  } catch (err) {
    console.error('[requireModuloCampanhas]', err?.message || err)
    return res.status(403).json({
      error: 'Módulo Campanhas desativado. Ative em Configurações gerais com a senha de ativação.',
      code: 'MODULO_CAMPANHAS_OFF',
    })
  }
}
