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
 * IDs de departamentos cujo nome é "Financeiro" (por empresa).
 * @param {number} company_id
 * @returns {Promise<number[]>}
 */
async function obterDepartamentoIdsFinanceiro(company_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return []

  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', cid)

  if (error || !Array.isArray(data)) return []

  return data
    .filter((d) => isNomeSetorFinanceiro(d?.nome))
    .map((d) => Number(d.id))
    .filter((id) => Number.isFinite(id) && id > 0)
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
  usuarioPertenceSetorFinanceiro,
  conversaNoSetorFinanceiro,
}
