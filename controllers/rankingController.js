'use strict'

/**
 * HTTP do ranking gamificado. company_id SEMPRE do JWT (req.user), nunca de body/query.
 * Permissões (rotas): leitura do ranking atual = qualquer usuário autenticado da empresa;
 * configuração e histórico = admin (middleware/adminOnly, o mesmo do resto do sistema).
 */

const rankingService = require('../services/rankingGamificado/rankingGamificadoService')

function responderErro(res, tag, error) {
  const status = Number(error?.statusCode) || 500
  if (status >= 500) console.error(`[ranking][${tag}]`, error?.message || error)
  return res
    .status(status)
    .json({ error: status >= 500 && status !== 503 ? 'Erro ao processar o ranking' : error.message })
}

exports.atual = async (req, res) => {
  try {
    const { company_id, id } = req.user
    const resumo = String(req.query.resumo || '') === '1'
    const data = await rankingService.getRankingAtual(company_id, id, { resumo, io: req.app.get('io') })
    return res.json(data)
  } catch (error) {
    return responderErro(res, 'atual', error)
  }
}

exports.obterConfig = async (req, res) => {
  try {
    const data = await rankingService.getPainelAdmin(req.user.company_id)
    return res.json(data)
  } catch (error) {
    return responderErro(res, 'config:get', error)
  }
}

exports.salvarConfig = async (req, res) => {
  try {
    const { company_id, id } = req.user
    const data = await rankingService.salvarConfig(company_id, id, req.body || {}, { io: req.app.get('io') })
    return res.json(data)
  } catch (error) {
    return responderErro(res, 'config:put', error)
  }
}

exports.historico = async (req, res) => {
  try {
    const data = await rankingService.listarHistorico(req.user.company_id, { limit: req.query.limit })
    return res.json(data)
  } catch (error) {
    return responderErro(res, 'historico', error)
  }
}
