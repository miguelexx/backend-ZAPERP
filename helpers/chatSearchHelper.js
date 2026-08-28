const { possiblePhonesBR } = require('./phoneHelper')

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '')
}

/**
 * Chave de nome equivalente ao search_name_key(text) do Postgres.
 * A pontuação vira separador de palavra para que "Shuarts/Marcela" possa ser
 * encontrada por "mar", sem fazer "hu" casar no meio de "Shuarts".
 */
function normalizeNameSearchKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Busca no início do nome ou no início de qualquer palavra do nome. */
function nameMatchesWordPrefix(value, rawTerm) {
  const nameKey = normalizeNameSearchKey(value)
  const termKey = normalizeNameSearchKey(rawTerm)
  if (!nameKey || !termKey) return false
  return nameKey.startsWith(termKey) || nameKey.includes(` ${termKey}`)
}

/**
 * Filtro defensivo aplicado à resposta da lista. Mantém a API correta durante
 * rollout, mesmo se o banco ainda estiver com a RPC antiga baseada em %termo%.
 */
function chatIdentityMatchesSearch(row, rawTerm) {
  const names = [
    row?.contato_nome,
    row?.nome_contato_cache,
    row?.nome_grupo,
    row?.cliente_nome,
    row?.pushname,
    row?.nome,
    row?.encontrado_por,
    ...(Array.isArray(row?.nomes_vinculados)
      ? row.nomes_vinculados.map((v) => (v && typeof v === 'object' ? v.nome : v))
      : []),
  ]
  if (names.some((name) => nameMatchesWordPrefix(name, rawTerm))) return true

  const termDigits = digitsOnly(rawTerm)
  if (!termDigits) return false
  const phones = [row?.telefone_exibivel, row?.cliente_telefone, row?.telefone, row?.numero]
  return phones.some((phone) => digitsOnly(phone).includes(termDigits))
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

/** Mesmo critério da lista + observacoes (GET /clientes e listagens administrativas). */
function buildClienteListagemSearchOr(raw) {
  const term = quoteOrValue(`%${escapeIlikePattern(raw)}%`)
  return [buildClienteSearchOr(raw), `observacoes.ilike.${term}`].join(',')
}

function buildTelefoneSearchOr(raw) {
  const term = quoteOrValue(`%${escapeIlikePattern(raw)}%`)
  const phoneTerms = buildPhoneSearchTerms(raw)
  return [
    `telefone.ilike.${term}`,
    ...phoneTerms.map((phone) => `telefone.ilike.${quoteOrValue(`%${phone}%`)}`),
  ].join(',')
}

// Limites de busca configuráveis por env var.
// Exportados para uso compartilhado entre chatController e chatListCountsService.
function getSearchMessagesPageSize() {
  const raw = Number(process.env.CHAT_SEARCH_MESSAGES_PAGE_SIZE)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}

function getChatSearchScanLimit() {
  const raw = Number(process.env.CHAT_SEARCH_SCAN_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 2000)
}

function getChatSearchIdLimit() {
  const raw = Number(process.env.CHAT_SEARCH_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 3000)
}

module.exports = {
  buildClienteSearchOr,
  buildClienteListagemSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  digitsOnly,
  normalizeNameSearchKey,
  nameMatchesWordPrefix,
  chatIdentityMatchesSearch,
  escapeIlikePattern,
  quoteOrValue,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
}
