const {
  getAlertaSemRespostaConfig,
  saveAlertaSemRespostaConfig,
  processCompanyAlertaSemResposta,
  listAlertaSemRespostaEventos,
} = require('../services/atendimentoSemRespostaService')

exports.getConfig = async (req, res) => {
  try {
    const { config } = await getAlertaSemRespostaConfig(req.user.company_id)
    return res.json(config)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao buscar configuracao' })
  }
}

exports.putConfig = async (req, res) => {
  try {
    const config = await saveAlertaSemRespostaConfig(req.user.company_id, req.body || {})
    return res.json({ ok: true, config })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || 'Erro ao salvar configuracao' })
  }
}

exports.listEventos = async (req, res) => {
  try {
    const eventos = await listAlertaSemRespostaEventos(req.user.company_id, {
      limit: req.query.limit,
      conversa_id: req.query.conversa_id,
    })
    return res.json({ eventos })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao listar eventos' })
  }
}

exports.processar = async (req, res) => {
  try {
    const dryRun =
      req.query.dry_run === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dry_run === true
    const result = await processCompanyAlertaSemResposta({
      company_id: req.user.company_id,
      io: req.app.get('io'),
      dryRun,
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao processar alerta sem resposta' })
  }
}
