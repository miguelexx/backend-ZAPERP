/**
 * Extração tolerante de listas/sucesso nas respostas JSON da Whapi.
 * Não importa nada da UltraMSG.
 */

function extractArray(data, keys = []) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

function firstHttpUrl(...values) {
  for (const value of values) {
    if (value == null) continue
    const s = String(value).trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return null
}

function isWhapiSuccessBody(httpOk, data) {
  if (!httpOk) return false
  if (data && typeof data === 'object') {
    if (data.success === false) return false
    if (data.error && data.error !== false) return false
  }
  return true
}

function notImplemented(method) {
  return { ok: false, notImplemented: true, httpStatus: 501, error: `whapi.${method} não implementado` }
}

module.exports = {
  extractArray,
  firstHttpUrl,
  isWhapiSuccessBody,
  notImplemented,
}
