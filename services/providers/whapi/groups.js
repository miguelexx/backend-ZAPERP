/**
 * Grupos Whapi — paths confirmados no OpenAPI 1.8.7 (readme + MCP).
 * Não misturar com UltraMSG. getGroups/getGroup continuam em ./chatsAdmin.js.
 */

const { resolveConfig } = require('./config')
const { toWhapiGroupId, toWhapiRecipient, toWhapiChatId } = require('./phones')
const { post, put, patch, del, get, getBinary } = require('./http')
const { isWhapiSuccessBody } = require('./parse')

function cfgMissing() {
  return { ok: false, httpStatus: null, data: null, error: 'Instância Whapi não configurada' }
}

function wrap({ ok, status, data, text }) {
  if (ok && isWhapiSuccessBody(ok, data)) {
    return { ok: true, httpStatus: status ?? 200, data: data && typeof data === 'object' ? data : {}, error: null }
  }
  const err = data && typeof data === 'object'
    ? (data.error?.message || data.error || data.message || null)
    : null
  return {
    ok: false,
    httpStatus: status ?? null,
    data: data && typeof data === 'object' ? data : null,
    error: String(err || text || `HTTP ${status || 'erro'}`).slice(0, 500),
  }
}

async function withCfg(opts) {
  const cfg = await resolveConfig(opts)
  return cfg || null
}

function contactIds(list) {
  const arr = Array.isArray(list) ? list : (list != null ? [list] : [])
  const out = []
  for (const item of arr) {
    const s = String(item || '').trim()
    if (!s) continue
    const lower = s.toLowerCase()
    if (lower.includes('@lid') || lower.includes('@s.whatsapp.net') || lower.includes('@g.us')) {
      if (!out.includes(s)) out.push(s)
      continue
    }
    const id = toWhapiRecipient(s) || s.replace(/\D/g, '')
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

async function mutate(method, endpoint, body, opts, { skipSendGuard = false } = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  try {
    const fn = method === 'PUT' ? put : method === 'PATCH' ? patch : method === 'DELETE' ? del : post
    const res = await fn({
      token: cfg.token,
      endpoint,
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard,
    })
    return wrap(res)
  } catch (e) {
    return { ok: false, httpStatus: null, data: null, error: e?.message || String(e) }
  }
}

async function createGroup(subject, participants, opts = {}) {
  const nome = String(subject || '').trim()
  const parts = contactIds(participants)
  if (!nome) return { ok: false, error: 'Informe o nome do grupo.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('POST', '/groups', { subject: nome, participants: parts }, opts)
}

async function acceptGroupInvite(inviteCode, opts = {}) {
  const code = String(inviteCode || '').trim()
  if (!code) return { ok: false, error: 'Informe o código do convite.' }
  return mutate('PUT', '/groups', { invite_code: code }, opts)
}

async function updateGroupInfo(groupId, fields = {}, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  const body = {}
  if (fields.subject != null) body.subject = String(fields.subject)
  if (fields.description != null) body.description = String(fields.description)
  if (!Object.keys(body).length) return { ok: false, error: 'Nada para atualizar.' }
  return mutate('PUT', `/groups/${encodeURIComponent(gid)}`, body, opts, { skipSendGuard: true })
}

async function leaveGroup(groupId, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}`, undefined, opts, { skipSendGuard: true })
}

async function updateGroupSetting(groupId, setting, policy, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const set = String(setting || '').trim()
  const pol = String(policy || '').trim()
  const allowedSet = new Set(['send_messages', 'edit_group_info', 'approve_participants', 'add_participants'])
  const allowedPol = new Set(['anyone', 'admins'])
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!allowedSet.has(set) || !allowedPol.has(pol)) {
    return { ok: false, error: 'Configuração de grupo inválida.' }
  }
  return mutate('PATCH', `/groups/${encodeURIComponent(gid)}`, { setting: set, policy: pol }, opts, { skipSendGuard: true })
}

async function getGroupInvite(groupId, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  try {
    const res = await get({ token: cfg.token, endpoint: `/groups/${encodeURIComponent(gid)}/invite` })
    const wrapped = wrap(res)
    if (wrapped.ok) {
      const code = String(wrapped.data?.invite_code || '').trim()
      wrapped.inviteCode = code
      wrapped.inviteLink = code ? `https://chat.whatsapp.com/${code}` : null
    }
    return wrapped
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function revokeGroupInvite(groupId, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}/invite`, undefined, opts, { skipSendGuard: true })
}

async function addGroupParticipant(groupId, participants, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const parts = contactIds(participants)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('POST', `/groups/${encodeURIComponent(gid)}/participants`, { participants: parts }, opts)
}

async function removeGroupParticipant(groupId, participants, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const parts = contactIds(participants)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}/participants`, { participants: parts }, opts)
}

async function promoteToGroupAdmin(groupId, participants, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const parts = contactIds(participants)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('PATCH', `/groups/${encodeURIComponent(gid)}/admins`, { participants: parts }, opts)
}

async function demoteGroupAdmin(groupId, participants, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const parts = contactIds(participants)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}/admins`, { participants: parts }, opts)
}

async function getGroupIcon(groupId, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  try {
    const res = await getBinary({ token: cfg.token, endpoint: `/groups/${encodeURIComponent(gid)}/icon` })
    if (!res.ok || !res.buffer || !res.buffer.length) {
      return { ok: false, httpStatus: res.status, error: 'Grupo sem foto.' }
    }
    const mime = String(res.contentType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg'
    return {
      ok: true,
      httpStatus: res.status,
      contentType: mime,
      dataUri: `data:${mime};base64,${res.buffer.toString('base64')}`,
      error: null,
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function setGroupIcon(groupId, media, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  const mediaStr = String(media || '').trim()
  if (!mediaStr) return { ok: false, error: 'Informe a imagem do grupo.' }
  const body = { media: mediaStr }
  if (opts.mimeType) body.mime_type = String(opts.mimeType)
  return mutate('PUT', `/groups/${encodeURIComponent(gid)}/icon`, body, opts, { skipSendGuard: true })
}

async function deleteGroupIcon(groupId, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}/icon`, undefined, opts, { skipSendGuard: true })
}

async function sendGroupInvite(inviteCode, to, extra = {}, opts = {}) {
  const code = String(inviteCode || '').trim()
  if (!code) return { ok: false, error: 'Informe o código do convite.' }
  const dest = toWhapiRecipient(to) || toWhapiChatId(to)
  if (!dest) return { ok: false, error: 'Destino inválido.' }
  const body = { to: dest }
  if (extra.title != null) body.title = String(extra.title)
  if (extra.body != null) body.body = String(extra.body)
  if (extra.quoted) body.quoted = String(extra.quoted)
  return mutate('POST', `/groups/link/${encodeURIComponent(code)}`, body, opts)
}

async function getGroupMetadataByInviteCode(inviteCode, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const code = String(inviteCode || '').trim()
  if (!code) return { ok: false, error: 'Informe o código do convite.' }
  try {
    const res = await get({ token: cfg.token, endpoint: `/groups/link/${encodeURIComponent(code)}` })
    return wrap(res)
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function getGroupApplicationsList(groupId, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const gid = toWhapiGroupId(groupId)
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  try {
    const extraParams = {}
    if (opts.count != null) extraParams.count = String(opts.count)
    if (opts.offset != null) extraParams.offset = String(opts.offset)
    const res = await get({
      token: cfg.token,
      endpoint: `/groups/${encodeURIComponent(gid)}/applications`,
      extraParams,
    })
    const wrapped = wrap(res)
    if (wrapped.ok) {
      wrapped.applications = Array.isArray(wrapped.data?.applications) ? wrapped.data.applications : []
    }
    return wrapped
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function approveGroupApplication(groupId, application, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const app = String(application || '').trim()
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!app) return { ok: false, error: 'Informe a solicitação.' }
  return mutate('POST', `/groups/${encodeURIComponent(gid)}/applications`, { application: app }, opts)
}

async function rejectGroupApplication(groupId, application, opts = {}) {
  const gid = toWhapiGroupId(groupId)
  const app = String(application || '').trim()
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  if (!app) return { ok: false, error: 'Informe a solicitação.' }
  return mutate('DELETE', `/groups/${encodeURIComponent(gid)}/applications`, { application: app }, opts)
}

module.exports = {
  createGroup,
  acceptGroupInvite,
  updateGroupInfo,
  leaveGroup,
  updateGroupSetting,
  getGroupInvite,
  revokeGroupInvite,
  addGroupParticipant,
  removeGroupParticipant,
  promoteToGroupAdmin,
  demoteGroupAdmin,
  getGroupIcon,
  setGroupIcon,
  deleteGroupIcon,
  sendGroupInvite,
  getGroupMetadataByInviteCode,
  getGroupApplicationsList,
  approveGroupApplication,
  rejectGroupApplication,
}
