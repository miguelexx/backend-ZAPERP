/**
 * Comunidades Whapi — paths confirmados no OpenAPI/readme.io (out/2026).
 * Espelha a estrutura de ./groups.js (wrap/mutate/contactIds). Só Whapi tem Communities;
 * UltraMSG não ganha estes métodos → needMethod devolve 501 naturalmente.
 *
 * REST:
 *   POST   /communities                         criar {subject, description}
 *   GET    /communities?count&offset            listar
 *   GET    /communities/{cid}                    obter (participants[], invite_code)
 *   GET    /communities/{cid}/subgroups          subgrupos {announceGroupInfo, otherGroups[]}
 *   POST   /communities/{cid}                     criar grupo na comunidade {subject, participants[], isHidden?}
 *   PUT    /communities/{cid}/{gid}               vincular grupo
 *   DELETE /communities/{cid}/{gid}               desvincular grupo
 *   POST   /communities/{cid}/participants        adicionar {participants[]} → {success, failed[], processed[]}
 *   DELETE /communities/{cid}/participants        remover {participants[]}
 *   PATCH  /communities/{cid}/admins              promover {participants[]}
 *   DELETE /communities/{cid}/admins              rebaixar {participants[]}
 *   PATCH  /communities/{cid}/settings            config {setting, policy}
 *   DELETE /communities/{cid}                      desativar
 *   DELETE /communities/{cid}/invite              revogar convite
 */

const { resolveConfig } = require('./config')
const { toWhapiGroupId, toWhapiRecipient } = require('./phones')
const { post, put, patch, del, get } = require('./http')
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

/** Normaliza lista de participantes em Contact IDs Whapi (reusa a regra de ./groups.js). */
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

// ------------------------------------------------------------------ CRIAR / LER

async function createCommunity(subject, description, opts = {}) {
  const nome = String(subject || '').trim()
  const desc = String(description || '').trim()
  if (!nome) return { ok: false, error: 'Informe o nome da comunidade.' }
  // description é obrigatório no OpenAPI; manda string vazia se o usuário não preencher.
  return mutate('POST', '/communities', { subject: nome, description: desc }, opts, { skipSendGuard: true })
}

async function getCommunities(opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const extraParams = {}
  if (opts.count != null) extraParams.count = String(opts.count)
  if (opts.offset != null) extraParams.offset = String(opts.offset)
  try {
    const res = await get({ token: cfg.token, endpoint: '/communities', extraParams })
    const wrapped = wrap(res)
    if (wrapped.ok) {
      // A Whapi devolve o array em `communities` (confirmado no ambiente real);
      // alguns builds/doc citam `groups`. Aceita ambos + array cru por robustez.
      const body = wrapped.data
      const list = Array.isArray(body?.communities) ? body.communities
        : Array.isArray(body?.groups) ? body.groups
        : Array.isArray(body) ? body
        : []
      wrapped.communities = list
      wrapped.total = Number(body?.total ?? list.length) || list.length
    }
    return wrapped
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function getCommunity(communityId, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const cid = toWhapiGroupId(communityId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  try {
    const res = await get({ token: cfg.token, endpoint: `/communities/${encodeURIComponent(cid)}` })
    const wrapped = wrap(res)
    if (wrapped.ok) {
      const code = String(wrapped.data?.invite_code || '').trim()
      wrapped.inviteCode = code || null
      wrapped.inviteLink = code ? `https://chat.whatsapp.com/${code}` : null
    }
    return wrapped
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function getCommunitySubGroups(communityId, opts = {}) {
  const cfg = await withCfg(opts)
  if (!cfg) return cfgMissing()
  const cid = toWhapiGroupId(communityId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  try {
    const res = await get({ token: cfg.token, endpoint: `/communities/${encodeURIComponent(cid)}/subgroups` })
    const wrapped = wrap(res)
    if (wrapped.ok) {
      wrapped.announceGroup = wrapped.data?.announceGroupInfo || null
      wrapped.subGroups = Array.isArray(wrapped.data?.otherGroups) ? wrapped.data.otherGroups : []
    }
    return wrapped
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// ------------------------------------------------------------------ GRUPOS

async function createGroupInCommunity(communityId, subject, participants, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const nome = String(subject || '').trim()
  const parts = contactIds(participants)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!nome) return { ok: false, error: 'Informe o nome do grupo.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante para criar o grupo.' }
  const body = { subject: nome, participants: parts }
  if (opts.isHidden != null) body.isHidden = opts.isHidden === true || opts.isHidden === 'true'
  return mutate('POST', `/communities/${encodeURIComponent(cid)}`, body, opts)
}

async function linkGroupToCommunity(communityId, groupId, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const gid = toWhapiGroupId(groupId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  return mutate('PUT', `/communities/${encodeURIComponent(cid)}/${encodeURIComponent(gid)}`, undefined, opts, { skipSendGuard: true })
}

async function unlinkGroupFromCommunity(communityId, groupId, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const gid = toWhapiGroupId(groupId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!gid) return { ok: false, error: 'Grupo inválido.' }
  return mutate('DELETE', `/communities/${encodeURIComponent(cid)}/${encodeURIComponent(gid)}`, undefined, opts, { skipSendGuard: true })
}

// ------------------------------------------------------------------ PARTICIPANTES

async function addCommunityParticipant(communityId, participants, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const parts = contactIds(participants)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  // Operação de risco anti-spam → passa pelo send guard (espaçamento por instância).
  return mutate('POST', `/communities/${encodeURIComponent(cid)}/participants`, { participants: parts }, opts)
}

async function removeCommunityParticipant(communityId, participants, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const parts = contactIds(participants)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('DELETE', `/communities/${encodeURIComponent(cid)}/participants`, { participants: parts }, opts, { skipSendGuard: true })
}

async function promoteCommunityParticipant(communityId, participants, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const parts = contactIds(participants)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('PATCH', `/communities/${encodeURIComponent(cid)}/admins`, { participants: parts }, opts, { skipSendGuard: true })
}

async function demoteCommunityParticipant(communityId, participants, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const parts = contactIds(participants)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!parts.length) return { ok: false, error: 'Informe ao menos um participante.' }
  return mutate('DELETE', `/communities/${encodeURIComponent(cid)}/admins`, { participants: parts }, opts, { skipSendGuard: true })
}

// ------------------------------------------------------------------ CONFIG / INVITE / DESATIVAR

async function changeCommunitySettings(communityId, setting, policy, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  const set = String(setting || '').trim()
  const pol = String(policy || '').trim()
  const allowedSet = new Set(['modify_groups', 'member_add_mode'])
  const allowedPol = new Set(['anyone', 'admins'])
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  if (!allowedSet.has(set) || !allowedPol.has(pol)) {
    return { ok: false, error: 'Configuração de comunidade inválida.' }
  }
  return mutate('PATCH', `/communities/${encodeURIComponent(cid)}/settings`, { setting: set, policy: pol }, opts, { skipSendGuard: true })
}

async function deactivateCommunity(communityId, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  return mutate('DELETE', `/communities/${encodeURIComponent(cid)}`, undefined, opts, { skipSendGuard: true })
}

/** Link de convite da comunidade: derivado do invite_code devolvido por getCommunity. */
async function getCommunityInvite(communityId, opts = {}) {
  const result = await getCommunity(communityId, opts)
  if (!result.ok) return result
  return {
    ok: true,
    httpStatus: result.httpStatus,
    data: { invite_code: result.inviteCode },
    inviteCode: result.inviteCode,
    inviteLink: result.inviteLink,
    error: null,
  }
}

async function revokeCommunityInvite(communityId, opts = {}) {
  const cid = toWhapiGroupId(communityId)
  if (!cid) return { ok: false, error: 'Comunidade inválida.' }
  return mutate('DELETE', `/communities/${encodeURIComponent(cid)}/invite`, undefined, opts, { skipSendGuard: true })
}

module.exports = {
  contactIds,
  createCommunity,
  getCommunities,
  getCommunity,
  getCommunitySubGroups,
  createGroupInCommunity,
  linkGroupToCommunity,
  unlinkGroupFromCommunity,
  addCommunityParticipant,
  removeCommunityParticipant,
  promoteCommunityParticipant,
  demoteCommunityParticipant,
  changeCommunitySettings,
  deactivateCommunity,
  getCommunityInvite,
  revokeCommunityInvite,
}
