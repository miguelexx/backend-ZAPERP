/**
 * Controller de campanhas.
 * Todas as rotas exigem auth e company_id do token.
 */

const supabase = require('../config/supabase')
const campanhaService = require('../services/campanhaService')
const { isEnabled, FLAGS } = require('../helpers/featureFlags')
const { registrar: registrarAuditoria } = require('../helpers/auditoriaLog')

function getCompanyId(req) {
  return req.user?.company_id
}

exports.listar = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const campanhas = await campanhaService.listar(company_id, { status: req.query.status })
    return res.json(campanhas)
  } catch (e) {
    console.error('[campanhaController] listar:', e)
    return res.status(500).json({ error: e?.message || 'Erro ao listar campanhas' })
  }
}

exports.obter = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const { data: camp, error } = await supabase
      .from('campanhas')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', company_id)
      .maybeSingle()
    if (error) throw error
    if (!camp) return res.status(404).json({ error: 'Campanha não encontrada' })
    return res.json(camp)
  } catch (e) {
    console.error('[campanhaController] obter:', e)
    return res.status(500).json({ error: e?.message || 'Erro' })
  }
}

exports.criar = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const campanha = await campanhaService.criar(company_id, req.body)
    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'campanha_criar',
      entidade: 'campanha',
      entidade_id: campanha?.id,
      detalhes_json: { nome: campanha?.nome, status: campanha?.status },
    })
    return res.status(201).json(campanha)
  } catch (e) {
    console.error('[campanhaController] criar:', e)
    return res.status(400).json({ error: e?.message || 'Erro ao criar campanha' })
  }
}

exports.atualizar = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const campanha = await campanhaService.atualizar(company_id, req.params.id, req.body)
    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'campanha_atualizar',
      entidade: 'campanha',
      entidade_id: campanha?.id,
      detalhes_json: { nome: campanha?.nome, status: campanha?.status },
    })
    return res.json(campanha)
  } catch (e) {
    console.error('[campanhaController] atualizar:', e)
    return res.status(400).json({ error: e?.message || 'Erro ao atualizar' })
  }
}

exports.excluir = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    await campanhaService.excluir(company_id, req.params.id)
    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'campanha_excluir',
      entidade: 'campanha',
      entidade_id: Number(req.params.id),
      detalhes_json: {},
    })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[campanhaController] excluir:', e)
    return res.status(400).json({ error: e?.message || 'Erro ao excluir' })
  }
}

exports.pausar = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const campanha = await campanhaService.pausar(company_id, req.params.id)
    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'campanha_pausar',
      entidade: 'campanha',
      entidade_id: campanha?.id,
      detalhes_json: { nome: campanha?.nome },
    })
    return res.json(campanha)
  } catch (e) {
    console.error('[campanhaController] pausar:', e)
    return res.status(400).json({ error: e?.message || 'Erro ao pausar' })
  }
}

exports.retomar = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const campanha = await campanhaService.retomar(company_id, req.params.id)
    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'campanha_retomar',
      entidade: 'campanha',
      entidade_id: campanha?.id,
      detalhes_json: { nome: campanha?.nome },
    })
    return res.json(campanha)
  } catch (e) {
    console.error('[campanhaController] retomar:', e)
    return res.status(400).json({ error: e?.message || 'Erro ao retomar' })
  }
}

exports.listarEnvios = async (req, res) => {
  try {
    if (!isEnabled(FLAGS.FEATURE_CAMPANHAS)) {
      return res.status(403).json({ error: 'Módulo de campanhas não está habilitado' })
    }
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const envios = await campanhaService.listarEnvios(company_id, req.params.id, { status: req.query.status })
    return res.json(envios)
  } catch (e) {
    console.error('[campanhaController] listarEnvios:', e)
    return res.status(500).json({ error: e?.message || 'Erro ao listar envios' })
  }
}
