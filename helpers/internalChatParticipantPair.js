/**
 * Chave canônica do par 1:1 (menorId:maiorId) para internal_conversations.participant_pair_key.
 */

/**
 * @param {number} userIdA
 * @param {number} userIdB
 * @returns {{ low: number, high: number, participant_pair_key: string }}
 */
function orderedPair(userIdA, userIdB) {
  const a = Number(userIdA)
  const b = Number(userIdB)
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error('IDs de usuário inválidos para par canônico')
  }
  if (a === b) {
    throw new Error('Conversa interna 1:1 não pode ser com o mesmo usuário')
  }
  const low = Math.min(a, b)
  const high = Math.max(a, b)
  return {
    low,
    high,
    participant_pair_key: `${low}:${high}`,
  }
}

/**
 * @param {string} key
 * @returns {{ low: number, high: number }|null}
 */
function parsePairKey(key) {
  if (typeof key !== 'string' || !/^[0-9]+:[0-9]+$/.test(key)) return null
  const [a, b] = key.split(':').map((x) => parseInt(x, 10))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a >= b) return null
  return { low: a, high: b }
}

module.exports = {
  orderedPair,
  parsePairKey,
}
