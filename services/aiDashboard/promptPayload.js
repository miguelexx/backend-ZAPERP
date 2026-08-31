'use strict'

/** Compacta JSON enviado à 2ª chamada OpenAI (formatAnswer). */

function compactDataForPrompt(value, depth = 0) {
  if (value == null) return value
  if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}... [truncado]` : value
  if (typeof value !== 'object') return value
  if (depth >= 7) return '[profundidade_truncada]'
  if (Array.isArray(value)) {
    const max = depth <= 2 ? 60 : 25
    const items = value.slice(0, max).map((item) => compactDataForPrompt(item, depth + 1))
    if (value.length > max) {
      items.push({ __truncated: true, total_original: value.length, exibidos: max })
    }
    return items
  }
  const out = {}
  const entries = Object.entries(value)
  const maxKeys = 90
  for (const [key, val] of entries.slice(0, maxKeys)) {
    out[key] = compactDataForPrompt(val, depth + 1)
  }
  if (entries.length > maxKeys) out.__keys_truncated = entries.length - maxKeys
  return out
}

function stringifyDataForPrompt(data) {
  const maxChars = Math.max(8000, Math.min(60000, Number(process.env.AI_PROMPT_MAX_CHARS) || 28000))
  const compact = compactDataForPrompt(data)
  const json = JSON.stringify(compact)
  if (!json || json.length <= maxChars) return json
  return JSON.stringify({
    __prompt_truncated: true,
    total_chars: json.length,
    preview_json_inicio: json.slice(0, maxChars),
  })
}

module.exports = {
  compactDataForPrompt,
  stringifyDataForPrompt,
}
