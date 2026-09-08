/**
 * Whapi entrega votos de enquete como IDs (SHA-256 base64 do texto da opção),
 * não como o texto legível. Este helper mapeia hash → label.
 * Docs Whapi: action.votes = ids; poll.results[].id casa com o nome.
 */

const crypto = require('crypto')

function pollOptionHash(optionText) {
  return crypto.createHash('sha256').update(String(optionText ?? ''), 'utf8').digest('base64')
}

function looksLikePollOptionHash(value) {
  const s = String(value || '').trim()
  if (!s || s.length < 16 || /\s/.test(s)) return false
  // Base64 clássico ou URL-safe, tipicamente termina com = / ==
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(s)
}

/**
 * @param {string[]} voteIds
 * @param {Array<string|{name?:string,id?:string,title?:string,text?:string}>} optionsOrResults
 * @returns {string[]} labels legíveis (preserva ordem; ignora ids sem match)
 */
function resolvePollVoteLabels(voteIds, optionsOrResults) {
  const votes = (Array.isArray(voteIds) ? voteIds : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  if (!votes.length) return []

  const entries = []
  for (const raw of Array.isArray(optionsOrResults) ? optionsOrResults : []) {
    if (raw == null) continue
    if (typeof raw === 'string') {
      const name = raw.trim()
      if (!name) continue
      entries.push({ name, id: pollOptionHash(name) })
      continue
    }
    if (typeof raw === 'object') {
      const name = String(raw.name ?? raw.title ?? raw.text ?? raw.option ?? '').trim()
      const id = raw.id != null ? String(raw.id).trim() : (name ? pollOptionHash(name) : '')
      if (!name && !id) continue
      entries.push({ name: name || id, id: id || (name ? pollOptionHash(name) : '') })
    }
  }

  const byId = new Map()
  for (const e of entries) {
    if (e.id) byId.set(e.id, e.name)
    // Variações de base64 URL-safe
    if (e.id) {
      byId.set(e.id.replace(/-/g, '+').replace(/_/g, '/'), e.name)
      byId.set(e.id.replace(/\+/g, '-').replace(/\//g, '_'), e.name)
    }
  }

  const labels = []
  for (const vote of votes) {
    const direct = byId.get(vote)
      || byId.get(vote.replace(/-/g, '+').replace(/_/g, '/'))
      || byId.get(vote.replace(/\+/g, '-').replace(/\//g, '_'))
    if (direct) {
      labels.push(direct)
      continue
    }
    // Já veio texto legível (não é hash)
    if (!looksLikePollOptionHash(vote)) {
      labels.push(vote)
      continue
    }
  }
  return labels
}

function buildPollOptionIdMap(options) {
  const list = Array.isArray(options) ? options : []
  return list
    .map((o) => String(o ?? '').trim())
    .filter(Boolean)
    .map((name) => ({ name, id: pollOptionHash(name) }))
}

module.exports = {
  pollOptionHash,
  looksLikePollOptionHash,
  resolvePollVoteLabels,
  buildPollOptionIdMap,
}
