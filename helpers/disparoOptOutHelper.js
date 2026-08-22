/**
 * Normalização e detecção de comandos de opt-out (Etapa 8 Disparo).
 */

const DEFAULT_PALAVRAS = ['SAIR', 'PARAR', 'CANCELAR', 'REMOVER', 'STOP']

const TRAILING_PUNCT_RE = /[!?.…]+$/u

function removeAccents(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

/**
 * trim → lower → remove acentos → remove pontuação final (!?.…)
 */
function normalizeOptOutCommand(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  const noAccent = removeAccents(trimmed).toLowerCase()
  return noAccent.replace(TRAILING_PUNCT_RE, '').trim()
}

/**
 * Match exato após normalização — não é substring.
 */
function isExactOptOutCommand(text, palavras = DEFAULT_PALAVRAS) {
  const normalized = normalizeOptOutCommand(text)
  if (!normalized) return false
  const set = (Array.isArray(palavras) ? palavras : DEFAULT_PALAVRAS)
    .map((p) => normalizeOptOutCommand(p))
    .filter(Boolean)
  return set.includes(normalized)
}

module.exports = {
  DEFAULT_PALAVRAS,
  normalizeOptOutCommand,
  isExactOptOutCommand,
  removeAccents,
}
