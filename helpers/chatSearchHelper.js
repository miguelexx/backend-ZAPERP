const { possiblePhonesBR } = require('./phoneHelper')

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '')
}

function unique(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))]
}

function escapeIlikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function buildPhoneSearchTerms(raw) {
  const digits = digitsOnly(raw)
  if (!digits) return []

  const variants = possiblePhonesBR(digits)
  const withoutCountryCode = digits.startsWith('55') && digits.length > 4 ? digits.slice(2) : ''
  const withCountryCode = !digits.startsWith('55') && digits.length >= 8 ? `55${digits}` : ''

  return unique([
    digits,
    withoutCountryCode,
    withCountryCode,
    ...variants,
  ])
}

function buildClienteSearchOr(raw) {
  const term = `%${escapeIlikePattern(raw)}%`
  const phoneTerms = buildPhoneSearchTerms(raw)
  return [
    `nome.ilike.${term}`,
    `pushname.ilike.${term}`,
    `telefone.ilike.${term}`,
    ...phoneTerms.map((phone) => `telefone.ilike.%${phone}%`),
  ].join(',')
}

function buildTelefoneSearchOr(raw) {
  const term = `%${escapeIlikePattern(raw)}%`
  const phoneTerms = buildPhoneSearchTerms(raw)
  return [
    `telefone.ilike.${term}`,
    ...phoneTerms.map((phone) => `telefone.ilike.%${phone}%`),
  ].join(',')
}

module.exports = {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  digitsOnly,
  escapeIlikePattern,
}
