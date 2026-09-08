/**
 * Labels do WhatsApp Business (Whapi) — superfície HTTP para o CRM (tags/kanban).
 * Só empresas com instância Whapi; UltraMSG não tem labels → 501 claro.
 * company_id SEMPRE de req.user. Aditivo: não toca o sistema de `tags` interno.
 * Ver doc 25 §30 + services/providers/whapi/labels.js.
 */

const { getProvider } = require('../services/providers')
const {
  getWhatsappInstanceById,
  getDefaultWhatsappInstance,
} = require('../services/whatsappInstanceService')

const NOT_WHAPI = 'Labels do WhatsApp Business exigem uma instância Whapi. A empresa não possui uma configurada.'

/**
 * Resolve a instância Whapi da empresa (explícita por query/body ou a default Whapi).
 * @returns {{ instance, error }}
 */
async function resolveWhapiInstance(companyId, explicitId) {
  if (explicitId) {
    const { instance, error } = await getWhatsappInstanceById(companyId, explicitId)
    if (!instance) return { instance: null, error: error || 'Instância não encontrada' }
    if (String(instance.provider || '').trim().toLowerCase() !== 'whapi') {
      return { instance: null, error: NOT_WHAPI }
    }
    return { instance, error: null }
  }
  const { instance } = await getDefaultWhatsappInstance(companyId, { provider: 'whapi' })
  if (!instance) return { instance: null, error: NOT_WHAPI }
  return { instance, error: null }
}

function instanceIdFromReq(req) {
  const raw = req.query?.whatsapp_instance_id ?? req.body?.whatsapp_instance_id
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Empacota a resolução da instância + provider Whapi; responde direto em caso de falha. */
async function withWhapi(req, res) {
  const company_id = req.user?.company_id
  if (!company_id) {
    res.status(401).json({ error: 'Não autenticado' })
    return null
  }
  const { instance, error } = await resolveWhapiInstance(company_id, instanceIdFromReq(req))
  if (!instance) {
    res.status(501).json({ error })
    return null
  }
  return {
    company_id,
    opts: { companyId: company_id, whatsappInstanceId: instance.id },
    provider: getProvider({ provider: 'whapi' }),
  }
}

/** GET /labels/whatsapp — lista os labels do WhatsApp Business. */
exports.listarLabels = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  try {
    const r = await ctx.provider.getLabels(ctx.opts)
    if (!r.ok) return res.status(502).json({ error: r.error || 'Erro ao listar labels' })
    return res.json({ labels: r.labels || [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao listar labels' })
  }
}

/** POST /labels/whatsapp  body { name, color, id? } — cria um label. */
exports.criarLabel = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  try {
    const r = await ctx.provider.createLabel(
      { name: req.body?.name, color: req.body?.color, id: req.body?.id },
      ctx.opts,
    )
    if (!r.ok) return res.status(400).json({ error: r.error || 'Erro ao criar label' })
    return res.status(201).json({ sucesso: true, label: r.label || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao criar label' })
  }
}

/** PATCH /labels/whatsapp/:labelId  body { name } — renomeia. */
exports.renomearLabel = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  try {
    const r = await ctx.provider.renameLabel(req.params?.labelId, req.body?.name, ctx.opts)
    if (!r.ok) return res.status(400).json({ error: r.error || 'Erro ao renomear label' })
    return res.json({ sucesso: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao renomear label' })
  }
}

/** DELETE /labels/whatsapp/:labelId — apaga. */
exports.excluirLabel = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  try {
    const r = await ctx.provider.deleteLabel(req.params?.labelId, ctx.opts)
    if (!r.ok) return res.status(400).json({ error: r.error || 'Erro ao apagar label' })
    return res.json({ sucesso: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao apagar label' })
  }
}

/** GET /labels/whatsapp/:labelId/chats — chats/mensagens associados ao label. */
exports.listarAssociacoes = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  try {
    const r = await ctx.provider.getLabelAssociations(req.params?.labelId, ctx.opts)
    if (!r.ok) return res.status(502).json({ error: r.error || 'Erro ao listar associações' })
    return res.json({ chats: r.chats || [], messages: r.messages || [] })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao listar associações' })
  }
}

/** POST /labels/whatsapp/:labelId/associacoes  body { chat } — associa label a um chat. */
exports.associarChat = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  const chat = req.body?.chat ?? req.body?.chat_id ?? req.body?.telefone
  if (!chat) return res.status(400).json({ error: 'Informe chat (telefone ou chat id).' })
  try {
    const r = await ctx.provider.addLabelAssociation(req.params?.labelId, chat, ctx.opts)
    if (!r.ok) return res.status(400).json({ error: r.error || 'Erro ao associar label' })
    return res.json({ sucesso: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao associar label' })
  }
}

/** DELETE /labels/whatsapp/:labelId/associacoes  body { chat } — remove associação. */
exports.desassociarChat = async (req, res) => {
  const ctx = await withWhapi(req, res)
  if (!ctx) return
  const chat = req.body?.chat ?? req.body?.chat_id ?? req.body?.telefone
  if (!chat) return res.status(400).json({ error: 'Informe chat (telefone ou chat id).' })
  try {
    const r = await ctx.provider.deleteLabelAssociation(req.params?.labelId, chat, ctx.opts)
    if (!r.ok) return res.status(400).json({ error: r.error || 'Erro ao remover associação' })
    return res.json({ sucesso: true })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao remover associação' })
  }
}
