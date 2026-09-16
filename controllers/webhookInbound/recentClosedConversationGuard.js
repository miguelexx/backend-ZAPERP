/**
 * Memória de curto prazo: conversa recém-encerrada + texto da mensagem de finalização.
 * Cobre a corrida em que o webhook do UltraMSG chega durante o sendText, antes do INSERT.
 * Um processo (PM2 fork) — não substitui o match no banco.
 */

const recent = new Map()
const TTL_MS = 2 * 60 * 1000

function conversationKey(companyId, conversaId) {
  return `${Number(companyId)}:${Number(conversaId)}`
}

function pruneExpired(now = Date.now()) {
  for (const [k, v] of recent) {
    if (!v || now - v.at > TTL_MS) recent.delete(k)
  }
}

function rememberClosedConversation({ companyId, conversaId, texto } = {}) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(convId) || convId <= 0) return
  pruneExpired()
  const k = conversationKey(cid, convId)
  const prev = recent.get(k) || { at: Date.now(), texts: [] }
  prev.at = Date.now()
  const t = String(texto || '').trim()
  if (t && !prev.texts.includes(t)) prev.texts.push(t)
  if (prev.texts.length > 8) prev.texts = prev.texts.slice(-8)
  recent.set(k, prev)
}

function getRecentClosedConversation(companyId, conversaId) {
  const k = conversationKey(companyId, conversaId)
  const rec = recent.get(k)
  if (!rec) return null
  if (Date.now() - rec.at > TTL_MS) {
    recent.delete(k)
    return null
  }
  return rec
}

function resetRecentClosedConversationsForTests() {
  recent.clear()
}

module.exports = {
  rememberClosedConversation,
  getRecentClosedConversation,
  resetRecentClosedConversationsForTests,
}
