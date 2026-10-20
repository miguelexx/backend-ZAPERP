const { usuarioTemPermissao } = require('../helpers/permissoesService')

/**
 * Gate genérico por código do catálogo de permissões (helpers/permissoesCatalogo.js).
 *
 * Até aqui só existiam gates por perfil (`adminOnly`, `supervisorOrAdmin`) e por módulo
 * (`requireModuloCampanhas`); `usuarioTemPermissao` era chamado inline em 2 controllers.
 * Este é o middleware único — decisão D7 do doc 36.
 *
 * Semântica idêntica à de `usuarioTemPermissao`: admin sempre passa; depois vale o override
 * explícito em `usuario_permissoes`; sem override, vale o padrão do perfil no catálogo.
 *
 * Fail-closed: sem `req.user` utilizável, ou com exceção na leitura, responde 403.
 *
 * O código precisa ser PONTILHADO (`orcamentos.ver`), porque `/me/permissoes` devolve um mapa
 * chaveado pelos `codigo` do catálogo. Código fora do catálogo nunca é concedido a não-admin
 * (`perfilTemPermissaoPorPadrao` devolve false), o que mascara o gate como "só admin" em vez
 * de falhar visivelmente — por isso o aviso em dev abaixo.
 *
 * @param {string} codigo código do catálogo, ex.: 'orcamentos.criar'
 * @returns {import('express').RequestHandler}
 */
function requirePermissao(codigo) {
  const permissao_codigo = String(codigo || '').trim()
  if (!permissao_codigo) {
    throw new Error('requirePermissao: código de permissão obrigatório')
  }
  if (process.env.NODE_ENV !== 'production') {
    const { PERMISSOES_POR_CODIGO } = require('../helpers/permissoesCatalogo')
    if (!PERMISSOES_POR_CODIGO[permissao_codigo]) {
      console.warn(
        `[requirePermissao] "${permissao_codigo}" não está no catálogo — só admin passaria. ` +
        'Adicione a entrada em helpers/permissoesCatalogo.js.'
      )
    }
  }

  return async function requirePermissaoMiddleware(req, res, next) {
    try {
      const usuario_id = req.user?.id
      const company_id = req.user?.company_id
      const perfil = req.user?.perfil
      if (!usuario_id || !company_id) {
        return res.status(403).json({
          error: 'Sem permissão para esta ação.',
          code: 'PERMISSAO_NEGADA',
          permissao: permissao_codigo,
        })
      }

      const permitido = await usuarioTemPermissao({
        usuario_id,
        company_id,
        perfil,
        permissao_codigo,
      })
      if (!permitido) {
        return res.status(403).json({
          error: 'Sem permissão para esta ação.',
          code: 'PERMISSAO_NEGADA',
          permissao: permissao_codigo,
        })
      }
      return next()
    } catch (err) {
      console.error('[requirePermissao]', permissao_codigo, err?.message || err)
      return res.status(403).json({
        error: 'Sem permissão para esta ação.',
        code: 'PERMISSAO_NEGADA',
        permissao: permissao_codigo,
      })
    }
  }
}

module.exports = requirePermissao
