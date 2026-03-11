/**
 * Controller de configurações operacionais e auditoria de eventos.
 */

const { getConfig, updateConfig } = require('../services/configOperacionalService')
const { listarEventos } = require('../services/operationalAuditService')
const { registrarEvento, TIPOS } = require('../services/operationalAuditService')

/** GET /config/operacional */
exports.getOperacional = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const config = await getConfig(company_id)
    return res.json(config)
  } catch (err) {
    console.error('[configOperacional] getOperacional:', err)
    return res.status(500).json({ error: 'Erro ao obter configuração operacional' })
  }
}

/** PUT /config/operacional */
exports.putOperacional = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const result = await updateConfig(company_id, req.body)
    if (!result.ok) return res.status(400).json({ error: result.error })

    await registrarEvento(company_id, TIPOS.CONFIG_ALTERADA, 'Configuração operacional alterada', {
      usuario_id,
      alteracoes: Object.keys(req.body)
    })

    return res.json(result.data || await getConfig(company_id))
  } catch (err) {
    console.error('[configOperacional] putOperacional:', err)
    return res.status(500).json({ error: 'Erro ao atualizar configuração operacional' })
  }
}

/** GET /config/auditoria-eventos */
exports.getAuditoriaEventos = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const { limit, offset, tipo } = req.query
    const result = await listarEventos(company_id, {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      tipo: tipo || undefined
    })

    if (!result.ok) return res.status(500).json({ error: result.error })
    return res.json({ eventos: result.eventos })
  } catch (err) {
    console.error('[configOperacional] getAuditoriaEventos:', err)
    return res.status(500).json({ error: 'Erro ao listar eventos' })
  }
}
