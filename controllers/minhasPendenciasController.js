const minhasPendenciasService = require('../services/minhasPendenciasService')

exports.obterMinhasPendencias = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id ?? req.user?.user_id)

    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant invalido' })
    }
    if (!Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(401).json({ error: 'Usuario invalido' })
    }

    const categoria = req.query.categoria
    if (categoria != null && String(categoria).trim() !== '') {
      const detalhe = await minhasPendenciasService.getMinhasPendenciasPorCategoria(
        company_id,
        usuario_id,
        categoria
      )
      return res.json(detalhe)
    }

    const resumo = await minhasPendenciasService.getMinhasPendenciasResumo(company_id, usuario_id)
    return res.json(resumo)
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message })
    }
    console.error('[MINHAS_PENDENCIAS] erro:', error)
    const categoria = req.query?.categoria
    if (categoria != null && String(categoria).trim() !== '') {
      return res.json({
        categoria: String(categoria).trim(),
        total: 0,
        conversa_ids: [],
        itens: [],
        degraded: true,
      })
    }
    return res.json({
      transferidosParaVoce: 0,
      aguardandoSuaResposta: 0,
      emAtraso: 0,
      degraded: true,
    })
  }
}
