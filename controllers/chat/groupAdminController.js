/**
 * Administração de grupos WhatsApp (Whapi). UltraMSG segue com getGroup quando existir;
 * mutações sem método no provider → 501.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { isGroupConversation } = require('../../helpers/conversaHelper')
const { normalizePhoneBR, possiblePhonesBR } = require('../../helpers/phoneHelper')
const { getDisplayName, isBadName } = require('../../helpers/contactEnrichment')
const { resolveConversationWhatsappInstance, resolveConversationProvider } = require('../../services/chat/identity/conversationAddressService')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { emitirConversaAtualizada } = require('../../services/chat/realtime/chatRealtimeGateway')
const { findOrCreateConversation } = require('../../helpers/conversationSync')
const { resolveWhatsappInstanceForManualAction } = require('../../services/whatsappInstanceService')

function providerOpts(companyId, whatsappInstanceId) {
  return { companyId, whatsappInstanceId: whatsappInstanceId || undefined }
}

function firstHttpUrl(...values) {
  for (const value of values) {
    if (value == null) continue
    const s = String(value).trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return null
}

/** Chave de grupo no banco: núcleo do JID, preservando hífen de grupos antigos. */
function groupPhoneKeyFromId(gid) {
  const raw = String(gid || '').trim()
  if (!raw) return ''
  const core = raw.replace(/@g\.us$/i, '').trim()
  if (/^[\d-]{10,40}$/.test(core)) return core
  const digits = core.replace(/\D/g, '')
  return digits || core
}

function groupJidFromConversa(conversa) {
  const tel = String(conversa?.telefone || '').trim()
  if (!tel || tel.toLowerCase().startsWith('grupo_') || tel.toLowerCase().startsWith('comunidade_') || tel.toLowerCase().startsWith('lid:')) return ''
  if (tel.toLowerCase().endsWith('@g.us')) return tel
  // Preserva `owner-timestamp` (ex. 553484080098-1406738663). Não stripar hífen.
  if (/^[\d-]{10,40}$/.test(tel)) return `${tel}@g.us`
  const digits = tel.replace(/\D/g, '')
  if (digits.length >= 10) return `${digits}@g.us`
  return ''
}

function participantIdentity(raw) {
  const id = String(raw?.id ?? raw ?? '').trim()
  const rank = String(raw?.rank || 'member').toLowerCase()
  const lower = id.toLowerCase()
  const isLid = lower.includes('@lid')
  const phone = isLid ? '' : id.replace(/@[^@]+$/, '').replace(/\D/g, '')
  const nameHint = String(raw?.name || raw?.pushname || raw?.notify || raw?.from_name || '').trim()
  return { id, rank: rank || 'member', phone, isLid, nameHint }
}

function mapSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      send_messages: 'anyone',
      edit_group_info: 'anyone',
      add_participants: 'anyone',
      approve_participants: 'anyone',
    }
  }
  const flag = (v, adminMeansAdmins = true) => {
    if (v === true || v === 'admins') return 'admins'
    if (v === false || v === 'anyone') return 'anyone'
    return adminMeansAdmins ? 'anyone' : 'anyone'
  }
  return {
    send_messages: flag(raw.announce ?? raw.only_admins_can_send_messages),
    edit_group_info: flag(raw.restrict ?? raw.only_admins_can_edit_info),
    add_participants: flag(raw.adminAddMemberMode ?? raw.only_admins_can_add_members),
    approve_participants: flag(
      raw.member_add_mode === 'admin_approval'
      || raw.approve_participants === true
      || raw.approve_participants === 'admins'
      || raw.approve_new_members === true
    ),
  }
}

async function enrichParticipants(companyId, participants) {
  const list = Array.isArray(participants) ? participants.map(participantIdentity) : []
  const phones = [...new Set(list.map((p) => p.phone).filter(Boolean))]
  const lookup = new Set()
  for (const p of phones) {
    lookup.add(p)
    const norm = normalizePhoneBR(p)
    if (norm) lookup.add(norm)
    for (const v of possiblePhonesBR(p)) lookup.add(v)
  }
  const phoneList = [...lookup].filter(Boolean)
  const byPhone = new Map()
  const CHUNK = 200
  for (let i = 0; i < phoneList.length; i += CHUNK) {
    const slice = phoneList.slice(i, i + CHUNK)
    const { data } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone, foto_perfil')
      .eq('company_id', companyId)
      .in('telefone', slice)
    for (const row of data || []) {
      const key = String(row.telefone || '').replace(/\D/g, '')
      if (key && !byPhone.has(key)) byPhone.set(key, row)
      const norm = normalizePhoneBR(row.telefone)
      if (norm && !byPhone.has(norm)) byPhone.set(norm, row)
    }
  }
  return list.map((p) => {
    const row = p.phone ? (byPhone.get(p.phone) || byPhone.get(normalizePhoneBR(p.phone) || '')) : null
    const nome = row ? (getDisplayName(row) || null) : null
    const hint = p.nameHint && !isBadName(p.nameHint) ? p.nameHint : null
    return {
      id: p.id,
      phone: p.phone || null,
      rank: p.rank,
      admin: p.rank === 'admin' || p.rank === 'creator',
      creator: p.rank === 'creator',
      nome: (nome && !isBadName(nome) ? nome : null) || hint || (p.isLid ? 'Contato' : (p.phone || 'Participante')),
      foto: row?.foto_perfil || null,
      cliente_id: row?.id || null,
    }
  })
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await fn(items[idx], idx)
    }
  }
  const n = Math.min(Math.max(1, limit), items.length || 1)
  await Promise.all(Array.from({ length: items.length ? n : 0 }, () => worker()))
  return out
}

function needsNameHydration(p) {
  if (!p?.phone) return false
  const nome = String(p.nome || '').trim()
  return !nome || nome === p.phone || isBadName(nome)
}

async function hydrateParticipantNamesFromProvider(provider, opts, participants) {
  if (!provider || typeof provider.getContactMetadata !== 'function') return participants
  const need = participants
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => needsNameHydration(p))
    .slice(0, 40)
  if (!need.length) return participants
  await mapWithConcurrency(need, 6, async ({ p, idx }) => {
    const meta = await provider.getContactMetadata(p.phone, opts).catch(() => null)
    if (!meta) return
    const name = meta.name || meta.pushname || meta.notify
    const next = { ...participants[idx] }
    if (name && !isBadName(name)) next.nome = String(name).trim()
    if (!next.foto && meta.imgUrl) next.foto = meta.imgUrl
    participants[idx] = next
  })
  return participants
}

async function loadGroupContext(req) {
  const company_id = Number(req.user?.company_id)
  const conversa_id = Number(req.params.id)
  const user_id = req.user?.id
  const perm = await assertPermissaoConversa({
    company_id,
    conversa_id,
    user_id,
    role: req.user?.perfil,
    user_dep_ids: req.user?.departamento_ids,
  })
  if (!perm.ok) return { error: perm }
  const { data: conv } = await supabase
    .from('conversas')
    .select('id, telefone, tipo, nome_grupo, foto_grupo, whatsapp_instance_id, company_id')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .maybeSingle()
  if (!conv || !isGroupConversation(conv)) {
    return { error: { status: 400, error: 'Esta conversa não é um grupo.' } }
  }
  const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conv)
  const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
  const provider = getProvider({ provider: instanceProvider })
  const jid = groupJidFromConversa(conv)
  return {
    company_id,
    conversa_id,
    conversa: conv,
    whatsappInstanceId,
    instanceProvider,
    provider,
    jid,
    opts: providerOpts(company_id, whatsappInstanceId),
  }
}

function needMethod(provider, name) {
  if (provider && typeof provider[name] === 'function') return null
  return { status: 501, error: 'Este WhatsApp não gerencia grupos por aqui. Use o aplicativo do celular.' }
}

function sendProviderResult(res, result, fallback = 'Não foi possível concluir a ação no grupo.') {
  if (result?.ok) return res.json({ ok: true, ...(result.data && typeof result.data === 'object' ? { data: result.data } : {}), inviteCode: result.inviteCode, inviteLink: result.inviteLink, applications: result.applications })
  const status = [400, 401, 403, 404, 409, 422, 429, 503].includes(Number(result?.httpStatus)) ? Number(result.httpStatus) : 422
  return res.status(status).json({ ok: false, error: result?.error || fallback })
}

async function persistGroupMeta(company_id, conversa_id, patch, io) {
  const clean = {}
  if (Object.prototype.hasOwnProperty.call(patch, 'nome_grupo')) clean.nome_grupo = patch.nome_grupo
  if (Object.prototype.hasOwnProperty.call(patch, 'foto_grupo')) clean.foto_grupo = patch.foto_grupo
  if (!Object.keys(clean).length) return
  await supabase.from('conversas').update(clean).eq('company_id', company_id).eq('id', conversa_id)
  if (io) emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id), ...clean })
}

exports.obterGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    if (!ctx.jid) {
      return res.json({
        ok: true,
        localOnly: true,
        id: null,
        name: ctx.conversa.nome_grupo || 'Grupo',
        description: '',
        participants: [],
        participants_count: 0,
        settings: mapSettings(null),
        canManage: false,
      })
    }
    const missing = needMethod(ctx.provider, 'getGroup')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const raw = await ctx.provider.getGroup(ctx.jid, { ...ctx.opts, resync: req.query.resync === '1' })
    if (!raw) return res.status(404).json({ error: 'Grupo não encontrado no WhatsApp.' })
    let participants = await enrichParticipants(ctx.company_id, raw.participants || raw.members || [])
    participants = await hydrateParticipantNamesFromProvider(ctx.provider, ctx.opts, participants)
    const name = String(raw.name || raw.subject || raw.title || ctx.conversa.nome_grupo || 'Grupo').trim()
    const description = String(raw.description || raw.desc || '').trim()
    const foto = firstHttpUrl(
      raw.chat_pic_full,
      raw.chat_pic,
      raw.picture,
      raw.image,
      raw.photo,
      raw.icon,
      ctx.conversa.foto_grupo
    )
    const settings = mapSettings(raw)
    const metaPatch = { nome_grupo: name || null }
    if (foto) metaPatch.foto_grupo = foto
    await persistGroupMeta(ctx.company_id, ctx.conversa_id, metaPatch, req.app?.get?.('io'))
    return res.json({
      ok: true,
      localOnly: false,
      id: raw.id || ctx.jid,
      name,
      description,
      created_at: raw.created_at || raw.creation || null,
      created_by: raw.created_by || null,
      participants_count: Number(raw.participants_count || raw.participantsCount || participants.length) || participants.length,
      participants,
      settings,
      invite_code: raw.invite_code || null,
      photo: foto || ctx.conversa.foto_grupo || null,
      canManage: ctx.instanceProvider === 'whapi',
      provider: ctx.instanceProvider,
    })
  } catch (err) {
    console.error('[obterGrupo]', err)
    return res.status(500).json({ error: 'Erro ao carregar o grupo' })
  }
}

exports.atualizarGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'updateGroupInfo')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.updateGroupInfo(ctx.jid, {
      subject: req.body?.nome ?? req.body?.subject,
      description: req.body?.descricao ?? req.body?.description,
    }, ctx.opts)
    if (result?.ok && req.body?.nome) {
      await persistGroupMeta(ctx.company_id, ctx.conversa_id, { nome_grupo: String(req.body.nome).trim() }, req.app?.get?.('io'))
    }
    return sendProviderResult(res, result, 'Não foi possível atualizar o grupo.')
  } catch (err) {
    console.error('[atualizarGrupo]', err)
    return res.status(500).json({ error: 'Erro ao atualizar o grupo' })
  }
}

exports.atualizarConfigGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'updateGroupSetting')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.updateGroupSetting(ctx.jid, req.body?.setting, req.body?.policy, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[atualizarConfigGrupo]', err)
    return res.status(500).json({ error: 'Erro ao atualizar configuração do grupo' })
  }
}

exports.sairGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'leaveGroup')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.leaveGroup(ctx.jid, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível sair do grupo.')
  } catch (err) {
    console.error('[sairGrupo]', err)
    return res.status(500).json({ error: 'Erro ao sair do grupo' })
  }
}

exports.obterConviteGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'getGroupInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getGroupInvite(ctx.jid, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[obterConviteGrupo]', err)
    return res.status(500).json({ error: 'Erro ao obter convite do grupo' })
  }
}

exports.revogarConviteGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'revokeGroupInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.revokeGroupInvite(ctx.jid, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[revogarConviteGrupo]', err)
    return res.status(500).json({ error: 'Erro ao revogar convite' })
  }
}

exports.enviarConviteGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'sendGroupInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    let code = String(req.body?.invite_code || req.body?.inviteCode || '').trim()
    if (!code && ctx.provider.getGroupInvite) {
      const inv = await ctx.provider.getGroupInvite(ctx.jid, ctx.opts)
      code = String(inv?.inviteCode || inv?.data?.invite_code || '').trim()
    }
    const to = req.body?.telefone || req.body?.to
    const result = await ctx.provider.sendGroupInvite(code, to, {
      title: req.body?.title,
      body: req.body?.body,
    }, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[enviarConviteGrupo]', err)
    return res.status(500).json({ error: 'Erro ao enviar convite' })
  }
}

exports.listarParticipantesGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    req.query = { ...(req.query || {}), resync: req.query?.resync }
    return exports.obterGrupo(req, res)
  } catch (err) {
    console.error('[listarParticipantesGrupo]', err)
    return res.status(500).json({ error: 'Erro ao listar participantes' })
  }
}

exports.adicionarParticipantesGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'addGroupParticipant')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes || req.body?.participants || req.body?.telefone
    const result = await ctx.provider.addGroupParticipant(ctx.jid, parts, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível adicionar ao grupo.')
  } catch (err) {
    console.error('[adicionarParticipantesGrupo]', err)
    return res.status(500).json({ error: 'Erro ao adicionar participante' })
  }
}

exports.removerParticipantesGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'removeGroupParticipant')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes || req.body?.participants || req.body?.telefone
    const result = await ctx.provider.removeGroupParticipant(ctx.jid, parts, ctx.opts)
    return sendProviderResult(res, result, 'Não foi possível remover do grupo.')
  } catch (err) {
    console.error('[removerParticipantesGrupo]', err)
    return res.status(500).json({ error: 'Erro ao remover participante' })
  }
}

exports.promoverAdminGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'promoteToGroupAdmin')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes || req.body?.participants || req.body?.telefone
    const result = await ctx.provider.promoteToGroupAdmin(ctx.jid, parts, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[promoverAdminGrupo]', err)
    return res.status(500).json({ error: 'Erro ao promover admin' })
  }
}

exports.rebaixarAdminGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'demoteGroupAdmin')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const parts = req.body?.participantes || req.body?.participants || req.body?.telefone
    const result = await ctx.provider.demoteGroupAdmin(ctx.jid, parts, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[rebaixarAdminGrupo]', err)
    return res.status(500).json({ error: 'Erro ao rebaixar admin' })
  }
}

exports.definirFotoGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'setGroupIcon')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const media = req.body?.media || req.body?.url
    const result = await ctx.provider.setGroupIcon(ctx.jid, media, { ...ctx.opts, mimeType: req.body?.mime_type })
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[definirFotoGrupo]', err)
    return res.status(500).json({ error: 'Erro ao alterar foto do grupo' })
  }
}

exports.removerFotoGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'deleteGroupIcon')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.deleteGroupIcon(ctx.jid, ctx.opts)
    if (result?.ok) await persistGroupMeta(ctx.company_id, ctx.conversa_id, { foto_grupo: null }, req.app?.get?.('io'))
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[removerFotoGrupo]', err)
    return res.status(500).json({ error: 'Erro ao remover foto do grupo' })
  }
}

exports.listarSolicitacoesGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'getGroupApplicationsList')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await ctx.provider.getGroupApplicationsList(ctx.jid, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[listarSolicitacoesGrupo]', err)
    return res.status(500).json({ error: 'Erro ao listar solicitações' })
  }
}

exports.aprovarSolicitacaoGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'approveGroupApplication')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const application = req.body?.application || req.body?.chatId || req.body?.telefone
    const result = await ctx.provider.approveGroupApplication(ctx.jid, application, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[aprovarSolicitacaoGrupo]', err)
    return res.status(500).json({ error: 'Erro ao aprovar solicitação' })
  }
}

exports.rejeitarSolicitacaoGrupo = async (req, res) => {
  try {
    const ctx = await loadGroupContext(req)
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error })
    const missing = needMethod(ctx.provider, 'rejectGroupApplication')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const application = req.body?.application || req.body?.chatId || req.body?.telefone
    const result = await ctx.provider.rejectGroupApplication(ctx.jid, application, ctx.opts)
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[rejeitarSolicitacaoGrupo]', err)
    return res.status(500).json({ error: 'Erro ao rejeitar solicitação' })
  }
}

exports.entrarPorConvite = async (req, res) => {
  try {
    const { company_id } = req.user
    const code = String(req.body?.invite_code || req.body?.inviteCode || '').trim()
    if (!code) return res.status(400).json({ error: 'Informe o código do convite.' })
    const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, req.body?.whatsapp_instance_id)
    if (instanceRes.error || !instanceRes.instanceId) {
      return res.status(400).json({ error: instanceRes.error || 'Instância WhatsApp não encontrada.' })
    }
    const instance = instanceRes.instance
    const provider = getProvider({ provider: instance.provider })
    const missing = needMethod(provider, 'acceptGroupInvite')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await provider.acceptGroupInvite(code, providerOpts(company_id, instance.id))
    if (!result?.ok) return sendProviderResult(res, result, 'Não foi possível entrar no grupo.')
    const gid = String(result.data?.group_id || result.data?.id || '').trim()
    if (gid) {
      const phone = gid.toLowerCase().endsWith('@g.us') ? gid : `${groupPhoneKeyFromId(gid)}@g.us`
      await findOrCreateConversation(supabase, {
        company_id,
        phone,
        isGroup: true,
        nomeGrupo: result.data?.name || null,
        whatsapp_instance_id: instance.id,
      }).catch(() => null)
    }
    return res.json({ ok: true, group_id: gid || null })
  } catch (err) {
    console.error('[entrarPorConvite]', err)
    return res.status(500).json({ error: 'Erro ao entrar no grupo' })
  }
}

exports.consultarConvite = async (req, res) => {
  try {
    const { company_id } = req.user
    const code = String(req.query?.code || req.body?.invite_code || '').trim()
    if (!code) return res.status(400).json({ error: 'Informe o código do convite.' })
    const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, req.query?.whatsapp_instance_id || req.body?.whatsapp_instance_id)
    if (instanceRes.error || !instanceRes.instanceId) {
      return res.status(400).json({ error: instanceRes.error || 'Instância WhatsApp não encontrada.' })
    }
    const instance = instanceRes.instance
    const provider = getProvider({ provider: instance.provider })
    const missing = needMethod(provider, 'getGroupMetadataByInviteCode')
    if (missing) return res.status(missing.status).json({ error: missing.error })
    const result = await provider.getGroupMetadataByInviteCode(code, providerOpts(company_id, instance.id))
    return sendProviderResult(res, result)
  } catch (err) {
    console.error('[consultarConvite]', err)
    return res.status(500).json({ error: 'Erro ao consultar convite' })
  }
}
