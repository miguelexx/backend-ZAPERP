/**
 * Presença leve em memória (por processo) para is_online / last_seen do chat interno.
 * Não substitui presença global do produto; só usado pelo módulo internal-chat.
 */

const byUser = new Map()

/**
 * @param {number} userId
 */
function registerConnect(userId) {
  const uid = Number(userId)
  if (!Number.isFinite(uid) || uid <= 0) return
  const cur = byUser.get(uid) || { n: 0, last_seen: null }
  cur.n += 1
  byUser.set(uid, cur)
}

/**
 * @param {number} userId
 */
function registerDisconnect(userId) {
  const uid = Number(userId)
  if (!Number.isFinite(uid) || uid <= 0) return
  const cur = byUser.get(uid)
  if (!cur) return
  cur.n = Math.max(0, cur.n - 1)
  if (cur.n === 0) {
    cur.last_seen = new Date().toISOString()
  }
  byUser.set(uid, cur)
}

/**
 * @param {number} userId
 * @returns {{ is_online: boolean, last_seen: string|null }}
 */
function snapshot(userId) {
  const uid = Number(userId)
  const cur = byUser.get(uid)
  const online = !!(cur && cur.n > 0)
  return {
    is_online: online,
    last_seen: online ? null : (cur?.last_seen ?? null),
  }
}

/**
 * @param {number[]} userIds
 * @returns {Record<string, { is_online: boolean, last_seen: string|null }>}
 */
function snapshotsForIds(userIds) {
  const out = {}
  const list = Array.isArray(userIds) ? userIds : []
  for (const id of list) {
    const uid = Number(id)
    if (!Number.isFinite(uid)) continue
    out[String(uid)] = snapshot(uid)
  }
  return out
}

module.exports = {
  registerConnect,
  registerDisconnect,
  snapshot,
  snapshotsForIds,
}
