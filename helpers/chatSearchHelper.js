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

// PostgREST usa "," e "(" ")" como caracteres de controle dentro de .or(...).
// Um valor de busca com parenteses (ex.: telefone com mascara "+55 (34) 9991-1246")
// quebra o parser do filtro inteiro — nao só essa condição, o .or() inteiro falha
// silenciosamente e nenhuma das condições (nem as numéricas, sem parênteses) casa.
// A própria documentação do PostgREST resolve isso envolvendo o valor em aspas duplas
// (com "e \ internos escapados por \).
function quoteOrValue(value) {
  const s = String(value ?? '')
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Abaixo disso, um fragmento numérico vira ruído: '999' por exemplo aparece como
// substring em quase qualquer telefone de 12-13 dígitos, gerando falsos positivos
// quando o termo buscado não tem relação alguma com telefone (ex.: texto livre com
// alguns dígitos no final). 4 dígitos cobre o padrão comum de busca pelos últimos
// dígitos do número e ainda evita esse efeito colateral.
const MIN_PHONE_SEARCH_DIGITS = 4

function buildPhoneSearchTerms(raw) {
  const digits = digitsOnly(raw)
  if (!digits || digits.length < MIN_PHONE_SEARCH_DIGITS) return []

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
  const term = quoteOrValue(`%${escapeIlikePattern(raw)}%`)
  const phoneTerms = buildPhoneSearchTerms(raw)
  return [
    `nome.ilike.${term}`,
    `pushname.ilike.${term}`,
    `telefone.ilike.${term}`,
    ...phoneTerms.map((phone) => `telefone.ilike.${quoteOrValue(`%${phone}%`)}`),
  ].join(',')
}

function buildTelefoneSearchOr(raw) {
  const term = quoteOrValue(`%${escapeIlikePattern(raw)}%`)
  const phoneTerms = buildPhoneSearchTerms(raw)
  return [
    `telefone.ilike.${term}`,
    ...phoneTerms.map((phone) => `telefone.ilike.${quoteOrValue(`%${phone}%`)}`),
  ].join(',')
}

module.exports = {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  digitsOnly,
  escapeIlikePattern,
}
