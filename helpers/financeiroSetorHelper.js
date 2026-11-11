const supabase = require('../config/supabase')

const FINANCEIRO_NOME_NORMALIZADO = 'financeiro'

function normalizarNomeSetor(nome) {
  return String(nome || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function isNomeSetorFinanceiro(nome) {
  return normalizarNomeSetor(nome) === FINANCEIRO_NOME_NORMALIZADO
}

/**
 * Cache por `company_id` da lista de departamentos "Financeiro" (doc 41 §7). GET /chats lia a
 * tabela `departamentos` inteira da empresa a cada página só para saber se o usuário é do
 * Financeiro. Setores mudam por semanas; os mutadores (`controllers/dashboard/departamentos.js` e
 * os departamentos padrão de `chatbotAutoConfigService`) invalidam.
 */
const _cacheFinanceiro = require('./shortTtlCache').create({
  name: 'departamentosFinanceiro',
  ttlMs: Number(process.env.FINANCEIRO_SETOR_CACHE_TTL_MS || 60_000),
  max: 500,
})

async function lerDepartamentoIdsFinanceiroDoBanco(cid) {
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', cid)

  // Lança (em vez de devolver []) para a falha NÃO ficar cacheada por um TTL inteiro.
  if (error) throw error
  if (!Array.isArray(data)) return []

  return data
    .filter((d) => isNomeSetorFinanceiro(d?.nome))
    .map((d) => Number(d.id))
    .filter((id) => Number.isFinite(id) && id > 0)
}

/**
 * IDs de departamentos cujo nome é "Financeiro" (por empresa). Cacheado por `company_id`;
 * em falha do banco devolve [] (como antes), sem cachear.
 * @param {number} company_id
 * @returns {Promise<number[]>}
 */
async function obterDepartamentoIdsFinanceiro(company_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return []
  try {
    const ids = await _cacheFinanceiro.wrap(cid, '', () => lerDepartamentoIdsFinanceiroDoBanco(cid))
    return [...ids]
  } catch (_) {
    return []
  }
}

/** Invalida os ids cacheados da empresa (sem argumento: todas). */
function invalidateFinanceiroSetorCache(company_id) {
  if (company_id == null) { _cacheFinanceiro.clear(); return }
  _cacheFinanceiro.invalidate(company_id)
}

/**
 * Usuário pertence ao setor Financeiro (qualquer departamento com esse nome).
 * @param {number[]} departamentoIds
 * @param {number} company_id
 */
async function usuarioPertenceSetorFinanceiro(departamentoIds, company_id) {
  const ids = Array.isArray(departamentoIds)
    ? departamentoIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : []
  if (ids.length === 0) return false

  const financeiroIds = await obterDepartamentoIdsFinanceiro(company_id)
  if (financeiroIds.length === 0) return false

  const setFin = new Set(financeiroIds.map(String))
  return ids.some((id) => setFin.has(String(id)))
}

/**
 * Conversa está no setor Financeiro.
 */
function conversaNoSetorFinanceiro(conversa, financeiroDeptIds) {
  const dep = conversa?.departamento_id ?? null
  if (dep == null) return false
  const setFin = new Set((financeiroDeptIds || []).map(String))
  return setFin.has(String(dep))
}

module.exports = {
  FINANCEIRO_NOME_NORMALIZADO,
  normalizarNomeSetor,
  isNomeSetorFinanceiro,
  obterDepartamentoIdsFinanceiro,
  invalidateFinanceiroSetorCache,
  _financeiroSetorCache: _cacheFinanceiro,
  usuarioPertenceSetorFinanceiro,
  conversaNoSetorFinanceiro,
}
