const minhasPendenciasService = require('../services/minhasPendenciasService')

exports.obterMinhasPendencias = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id ?? req.user?.user_id)

    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }
    if (!Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
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
    return res.status(500).json({ error: 'Erro ao calcular minhas pendências' })
  }
}
