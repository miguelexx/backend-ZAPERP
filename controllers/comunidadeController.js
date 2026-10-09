/**
 * Controller de Comunidades (WhatsApp Communities via Whapi) — admin-only (ver routes).
 * Segue o padrão de controllers/chat/groupAdminController.js:
 *   company_id SEMPRE de req.user; instância resolvida por empresa; needMethod → 501; sendProviderResult.
 * Comunidades/grupos/participantes/admins são lidos AO VIVO da Whapi. Adição em massa vai p/ a FILA.
 */

const { getProvider } = require('../services/providers')
const { resolveWhatsappInstanceForManualAction } = require('../services/whatsappInstanceService')
const fila = require('../services/comunidade/comunidadeFilaService')
const { getComunidadeWorkerConfig, resolverLimitesInstancia } = require('../helpers/comunidadeWorkerConfig')

function providerOpts(companyId, whatsappInstanceId) {
  return { companyId, whatsappInstanceId: whatsappInstanceId || undefined }
}

function needMethod(provider, name) {
  if (provider && typeof provider[name] === 'function') return null
  return { status: 501, error: 'Este WhatsApp não gerencia comunidades por aqui. Use uma instância Whapi.' }
}

function sendProviderResult(res, result, fallback = 'Não foi possível concluir a ação na comunidade.') {
  if (result?.ok) {
    return res.json({
      ok: true,
      ...(result.data && typeof result.data === 'object' ? { data: result.data } : {}),
      inviteCode: result.inviteCode,
      inviteLink: result.inviteLink,
    })
  }
  const raw = Number(result?.httpStatus)
  // NUNCA devolver 401 daqui: o 401 da Whapi significa "canal do WhatsApp sem autorização"
  // (número desconectado), e o interceptor do front trata qualquer 401 como sessão expirada
  // → desloga e manda pro /login. Remapeamos para 409 (desconectado) com mensagem clara.
  if (raw === 401) {
    return res.status(409).json({
      ok: false,
      codigo: 'WHATSAPP_DESCONECTADO',
      error: 'WhatsApp desconectado. Reconecte o número Whapi para gerenciar comunidades.',
    })
  }
  const status = [400, 403, 404, 409, 422, 429, 503].includes(raw) ? raw : 422
  return res.status(status).json({ ok: false, error: result?.error || fallback })
}

/** Resolve a instância Whapi da empresa a partir de body/query. */
async function resolveCtx(req) {
  const company_id = Number(req.user?.company_id)
  const requested = req.body?.whatsapp_instance_id ?? req.query?.whatsapp_instance_id
  const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, requested)
  if (instanceRes.error || !instanceRes.instanceId) {
    return { error: { status: 400, error: instanceRes.error || 'Instância WhatsApp indisponível.', code: instanceRes.code } }
  }
  const instance = instanceRes.instance
  if (String(instance.provider || '').toLowerCase() !== 'whapi') {
    return { error: { status: 400, error: 'Comunidades exigem uma instância Whapi.' } }
  }
  const provider = getProvider({ provider: instance.provider })
  return {
    company_id,
    instance,
    provider,
    opts: providerOpts(company_id, instance.id),
  }
}

function cidFromParams(req) {
  return String(req.params.cid || '').trim()
}

// ---------------------------------------------------------------- LISTAR / CRIAR

exports.listarComunidades = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'getCommunities')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getCommunities({
      ...ctx.opts,
      count: req.query?.count,
      offset: req.query?.offset,
    })
    if (!result?.ok) return sendProviderResult(res, result, 'Não foi possível listar comunidades.')
    return res.json({ ok: true, comunidades: result.communities || [], total: result.total || 0, whatsapp_instance_id: ctx.instance.id })
  } catch (err) {
    console.error('[listarComunidades]', err)
    return res.status(500).json({ error: 'Erro ao listar comunidades' })
  }
}

exports.criarComunidade = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'createCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const subject = req.body?.nome ?? req.body?.subject
    const description = req.body?.descricao ?? req.body?.description ?? ''
    const result = await ctx.provider.createCommunity(subject, description, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível criar a comunidade.')
  } catch (err) {
    console.error('[criarComunidade]', err)
    return res.status(500).json({ error: 'Erro ao criar comunidade' })
  }
}

exports.obterComunidade = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'getCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getCommunity(cidFromParams(req), ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível carregar a comunidade.')
  } catch (err) {
    console.error('[obterComunidade]', err)
    return res.status(500).json({ error: 'Erro ao carregar comunidade' })
  }
}

exports.listarSubgrupos = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'getCommunitySubGroups')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getCommunitySubGroups(cidFromParams(req), ctx.opts)
    if (!result?.ok) return sendProviderResult(res, result, 'Não foi possível listar os grupos.')
    return res.json({ ok: true, announceGroup: result.announceGroup || null, subGroups: result.subGroups || [] })
  } catch (err) {
    console.error('[listarSubgrupos]', err)
    return res.status(500).json({ error: 'Erro ao listar subgrupos' })
  }
}

// ---------------------------------------------------------------- GRUPOS

exports.criarGrupoNaComunidade = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'createGroupInCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const subject = req.body?.nome ?? req.body?.subject
    const participantes = req.body?.participantes ?? req.body?.participants ?? []
    const result = await ctx.provider.createGroupInCommunity(cidFromParams(req), subject, participantes, {
      ...ctx.opts, isHidden: req.body?.isHidden,
    })
    return sendProviderResult(res, result, 'Não foi possível criar o grupo na comunidade.')
  } catch (err) {
    console.error('[criarGrupoNaComunidade]', err)
    return res.status(500).json({ error: 'Erro ao criar grupo na comunidade' })
  }
}

exports.vincularGrupo = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'linkGroupToCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.linkGroupToCommunity(cidFromParams(req), req.params.gid, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível vincular o grupo.')
  } catch (err) {
    console.error('[vincularGrupo]', err)
    return res.status(500).json({ error: 'Erro ao vincular grupo' })
  }
}

exports.desvincularGrupo = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'unlinkGroupFromCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.unlinkGroupFromCommunity(cidFromParams(req), req.params.gid, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível desvincular o grupo.')
  } catch (err) {
    console.error('[desvincularGrupo]', err)
    return res.status(500).json({ error: 'Erro ao desvincular grupo' })
  }
}

// ---------------------------------------------------------------- CONFIG / ADMINS / INVITE / DESATIVAR

exports.configurarComunidade = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'changeCommunitySettings')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.changeCommunitySettings(cidFromParams(req), req.body?.setting, req.body?.policy, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível atualizar as configurações.')
  } catch (err) {
    console.error('[configurarComunidade]', err)
    return res.status(500).json({ error: 'Erro ao configurar comunidade' })
  }
}

exports.promoverAdmin = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'promoteCommunityParticipant')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes ?? req.body?.participants ?? req.body?.telefone
    const result = await ctx.provider.promoteCommunityParticipant(cidFromParams(req), parts, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível promover o responsável.')
  } catch (err) {
    console.error('[promoverAdmin]', err)
    return res.status(500).json({ error: 'Erro ao promover admin' })
  }
}

exports.rebaixarAdmin = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'demoteCommunityParticipant')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes ?? req.body?.participants ?? req.body?.telefone
    const result = await ctx.provider.demoteCommunityParticipant(cidFromParams(req), parts, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível rebaixar o responsável.')
  } catch (err) {
    console.error('[rebaixarAdmin]', err)
    return res.status(500).json({ error: 'Erro ao rebaixar admin' })
  }
}

exports.obterConvite = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'getCommunityInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getCommunityInvite(cidFromParams(req), ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível obter o convite.')
  } catch (err) {
    console.error('[obterConvite]', err)
    return res.status(500).json({ error: 'Erro ao obter convite' })
  }
}

exports.revogarConvite = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'revokeCommunityInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.revokeCommunityInvite(cidFromParams(req), ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível revogar o convite.')
  } catch (err) {
    console.error('[revogarConvite]', err)
    return res.status(500).json({ error: 'Erro ao revogar convite' })
  }
}

exports.desativarComunidade = async (req, res) => {
  try {
    const ctx = await resolveCtx(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
    const missing = needMethod(ctx.provider, 'deactivateCommunity')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.deactivateCommunity(cidFromParams(req), ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível desativar a comunidade.')
  } catch (err) {
    console.error('[desativarComunidade]', err)
    return res.status(500).json({ error: 'Erro ao desativar comunidade' })
  }
}

// ---------------------------------------------------------------- FILA (adição em massa protegida)

async function enfileirar(req, res, operacao) {
  const ctx = await resolveCtx(req)
  if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error, code: ctx.error.code })
  const io = req.app?.get?.('io')
  const participantes = req.body?.participantes ?? req.body?.participants ?? []
  const cfg = getComunidadeWorkerConfig()
  const r = await fila.enfileirarParticipantes({
    io,
    companyId: ctx.company_id,
    instanceId: ctx.instance.id,
    comunidadeId: cidFromParams(req),
    comunidadeNome: req.body?.comunidade_nome || null,
    participantes,
    operacao,
    criadoPor: req.user?.id || null,
    maxTentativas: cfg.maxTentativas,
  })
  if (r?.error) return res.status(400).json({ error: r.error })
  // ETA estimado pelo teto conservador por dia da instância
  const limites = resolverLimitesInstancia(ctx.instance.metadata)
  const porDia = Math.max(1, limites.porDia || 100)
  const diasEstimados = r.total > 0 ? Math.ceil(r.total / porDia) : 0
  return res.json({
    ok: true,
    operacao: r.operacao || null,
    total: r.total || 0,
    ignorados: r.ignorados || 0,
    jaNaFila: r.jaNaFila || 0,
    vazio: !!r.vazio,
    eta: { porDia, diasEstimados },
  })
}

exports.enfileirarParticipantes = (req, res) => enfileirar(req, res, 'add').catch((err) => {
  console.error('[enfileirarParticipantes]', err)
  return res.status(500).json({ error: 'Erro ao enfileirar participantes' })
})

exports.enfileirarRemocao = (req, res) => enfileirar(req, res, 'remove').catch((err) => {
  console.error('[enfileirarRemocao]', err)
  return res.status(500).json({ error: 'Erro ao enfileirar remoção' })
})

// ---------------------------------------------------------------- OPERAÇÕES (progresso)

exports.listarOperacoes = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    const ops = await fila.listarOperacoes(company_id, { limit: req.query?.limit })
    return res.json({ ok: true, operacoes: ops })
  } catch (err) {
    console.error('[listarOperacoes]', err)
    return res.status(500).json({ error: 'Erro ao listar operações' })
  }
}

exports.obterOperacao = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    const op = await fila.obterOperacao(company_id, req.params.id)
    if (!op) return res.status(404).json({ error: 'Operação não encontrada.' })
    return res.json({ ok: true, operacao: op })
  } catch (err) {
    console.error('[obterOperacao]', err)
    return res.status(500).json({ error: 'Erro ao obter operação' })
  }
}

async function mudarStatusOperacao(req, res, acao) {
  const company_id = Number(req.user?.company_id)
  const io = req.app?.get?.('io')
  const r = await fila.alterarStatusOperacao({ io, companyId: company_id, operacaoId: req.params.id, acao })
  if (r?.error) return res.status(r.status || 400).json({ error: r.error })
  return res.json({ ok: true, operacao: r.operacao })
}

exports.pausarOperacao = (req, res) => mudarStatusOperacao(req, res, 'pausar').catch((err) => {
  console.error('[pausarOperacao]', err); return res.status(500).json({ error: 'Erro ao pausar operação' })
})
exports.retomarOperacao = (req, res) => mudarStatusOperacao(req, res, 'retomar').catch((err) => {
  console.error('[retomarOperacao]', err); return res.status(500).json({ error: 'Erro ao retomar operação' })
})
exports.cancelarOperacao = (req, res) => mudarStatusOperacao(req, res, 'cancelar').catch((err) => {
  console.error('[cancelarOperacao]', err); return res.status(500).json({ error: 'Erro ao cancelar operação' })
})
