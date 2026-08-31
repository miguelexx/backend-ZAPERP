'use strict'

/** Modelo, clamp de período e agregação de tokens OpenAI. */

// ── Configuração ──────────────────────────────────────────────────────────────
// Modelo padrão da IA. Pode ser sobrescrito via variável de ambiente AI_MODEL.
// Recomenda-se usar um modelo mais avançado (ex: "gpt-4.1" ou superior) para
// obter respostas mais gerais e inteligentes.
const AI_MODEL = () => process.env.AI_MODEL || 'gpt-4o-mini'

/** Limita period_days ao intervalo válido 1–365 (default 7). */
function clampDays(n) {
  const x = Math.trunc(Number(n))
  if (!Number.isFinite(x) || x < 1) return 7
  return Math.min(365, x)
}

function chunkArray(arr, size) {
  const a = arr || []
  const out = []
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size))
  return out
}

function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0
  const total = Number(usage.total_tokens ?? (prompt + completion)) || 0
  return {
    prompt_tokens: Math.max(0, Math.floor(prompt)),
    completion_tokens: Math.max(0, Math.floor(completion)),
    total_tokens: Math.max(0, Math.floor(total)),
  }
}

function addUsage(a, b) {
  const x = normalizeOpenAiUsage(a)
  const y = normalizeOpenAiUsage(b)
  return {
    prompt_tokens: x.prompt_tokens + y.prompt_tokens,
    completion_tokens: x.completion_tokens + y.completion_tokens,
    total_tokens: x.total_tokens + y.total_tokens,
  }
}

module.exports = {
  AI_MODEL,
  clampDays,
  chunkArray,
  normalizeOpenAiUsage,
  addUsage,
}
