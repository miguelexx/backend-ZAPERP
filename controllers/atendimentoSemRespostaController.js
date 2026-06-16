const {
  getAlertaSemRespostaConfig,
  saveAlertaSemRespostaConfig,
  listAlertaSemRespostaEventos,
  processCompanyAtendimentoSemResposta,
} = require('../services/atendimentoSemRespostaService')

/** GET /config/alerta-sem-resposta */
exports.getConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const config = await getAlertaSemRespostaConfig(company_id)
    res.set('Cache-Control', 'private, no-store, must-revalidate')
    return res.json(config)
  } catch (err) {
    console.error('[atendimentoSemResposta] getConfig:', err)
    return res.status(500).json({ error: 'Erro ao carregar alertas de atendimento' })
  }
}

/** PUT /config/alerta-sem-resposta */
exports.putConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await saveAlertaSemRespostaConfig(company_id, body)
    if (!result.ok) return res.status(400).json({ error: result.error })
    return res.json({ config: result.config, ...result.config })
  } catch (err) {
    console.error('[atendimentoSemResposta] putConfig:', err)
    return res.status(500).json({ error: 'Erro ao salvar alertas de atendimento' })
  }
}

/** GET /config/alerta-sem-resposta/eventos */
exports.getEventos = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const { limit, offset } = req.query
    const result = await listAlertaSemRespostaEventos(company_id, {
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    })
    if (!result.ok) return res.status(500).json({ error: result.error || 'Erro ao listar eventos' })
    return res.json({ eventos: result.eventos })
  } catch (err) {
    console.error('[atendimentoSemResposta] getEventos:', err)
    return res.status(500).json({ error: 'Erro ao listar eventos de alerta' })
  }
}

/** POST /config/alerta-sem-resposta/processar */
exports.processar = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const dryRun = req.body?.dry_run === true || req.query?.dry_run === '1' || req.query?.dry_run === 'true'
    const io = req.app?.get?.('io') || null
    const result = await processCompanyAtendimentoSemResposta(company_id, { dryRun, io })
    if (!result.ok) return res.status(500).json({ error: result.error || 'Falha ao processar' })
    return res.json({
      ok: true,
      dry_run: dryRun,
      processadas: result.processadas || 0,
      detalhes: result.detalhes || [],
      skipped: result.skipped || null,
    })
  } catch (err) {
    console.error('[atendimentoSemResposta] processar:', err)
    return res.status(500).json({ error: 'Erro ao processar alertas' })
  }
}
