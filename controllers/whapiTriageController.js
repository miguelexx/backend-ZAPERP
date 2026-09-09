/**
 * Triagem Interativa Whapi — superfície HTTP de configuração (por instância Whapi).
 * Só empresas com instância Whapi; UltraMSG → 501 claro. company_id SEMPRE de req.user.
 * Aditivo: não toca ia_config / chatbot_triage. Ver doc 26.
 */

const {
  getWhatsappInstanceById,
  listWhatsappInstances,
} = require('../services/whatsappInstanceService')
const {
  getWhapiTriageConfigRaw,
  saveWhapiTriageConfig,
} = require('../services/whapiTriage/whapiTriageConfigService')

const NOT_WHAPI = 'A Triagem Interativa exige uma instância Whapi. Selecione um canal Whapi.'

function isWhapi(instance) {
  return String(instance?.provider || '').trim().toLowerCase() === 'whapi'
}

function instanceIdFromReq(req) {
  const raw = req.query?.whatsapp_instance_id ?? req.body?.whatsapp_instance_id
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Resolve a instância Whapi (explícita ou a única Whapi da empresa). */
async function resolveWhapiInstance(company_id, explicitId) {
  if (explicitId) {
    const { instance, error } = await getWhatsappInstanceById(company_id, explicitId)
    if (!instance) return { instance: null, error: error || 'Instância não encontrada' }
    if (!isWhapi(instance)) return { instance: null, error: NOT_WHAPI }
    return { instance, error: null }
  }
  const { instances } = await listWhatsappInstances(company_id)
  const whapis = (instances || []).filter(isWhapi)
  if (!whapis.length) return { instance: null, error: NOT_WHAPI }
  const chosen = whapis.find((i) => i.is_default) || whapis[0]
  return { instance: chosen, error: null }
}

/**
 * GET /api/whapi/triagem/instances — lista os canais Whapi da empresa (para o seletor da página).
 */
exports.listarInstancias = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  try {
    const { instances } = await listWhatsappInstances(company_id)
    const whapis = (instances || []).filter(isWhapi).map((i) => ({
      id: i.id,
      nome: i.nome,
      instance_id: i.instance_id,
      is_default: i.is_default === true,
      ativo: i.ativo !== false,
      telefone_conectado: i.telefone_conectado || null,
    }))
    return res.json({ instances: whapis, hasWhapi: whapis.length > 0 })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao listar canais Whapi' })
  }
}

/**
 * GET /api/whapi/triagem/config?whatsapp_instance_id= — config atual (cria defaults em memória).
 */
exports.getConfig = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const { instance, error } = await resolveWhapiInstance(company_id, instanceIdFromReq(req))
  if (!instance) return res.status(501).json({ error })
  try {
    const { config, exists, migrationPending } = await getWhapiTriageConfigRaw(company_id, instance.id)
    return res.json({
      whatsapp_instance_id: instance.id,
      instance: { id: instance.id, nome: instance.nome, instance_id: instance.instance_id },
      exists: !!exists,
      migrationPending: !!migrationPending,
      config,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao carregar configuração' })
  }
}

/**
 * PUT /api/whapi/triagem/config body { whatsapp_instance_id, config } — salva (admin).
 */
exports.saveConfig = async (req, res) => {
  const company_id = req.user?.company_id
  if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
  const explicitId = instanceIdFromReq(req)
  const { instance, error } = await resolveWhapiInstance(company_id, explicitId)
  if (!instance) return res.status(501).json({ error })

  const payload = req.body?.config
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'config inválida' })
  }
  try {
    const result = await saveWhapiTriageConfig(company_id, instance.id, payload)
    if (!result.ok) {
      const status = result.migrationPending ? 503 : 400
      return res.status(status).json({ error: result.error, migrationPending: !!result.migrationPending })
    }
    return res.json({ sucesso: true, whatsapp_instance_id: instance.id, config: result.config })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro ao salvar configuração' })
  }
}
