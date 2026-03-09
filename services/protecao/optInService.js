/**
 * Módulo de proteção: verificação de opt-in antes de envio comercial.
 * Opcional — falha não impede envio. Ativado por FEATURE_PROTECAO.
 */

const supabase = require('../../config/supabase')

/**
 * Verifica se contato possui opt-in ativo.
 * @param {number} company_id
 * @param {number} cliente_id
 * @returns {Promise<boolean>}
 */
async function temOptIn(company_id, cliente_id) {
  if (!company_id || !cliente_id) return false
  const { data } = await supabase
    .from('contato_opt_in')
    .select('id')
    .eq('company_id', company_id)
    .eq('cliente_id', cliente_id)
    .eq('ativo', true)
    .limit(1)
  return !!(data && data.length > 0)
}

module.exports = { temOptIn }
