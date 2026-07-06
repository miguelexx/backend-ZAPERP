const supabase = require('../config/supabase')

/**
 * Modo simples de atendimento ativo para a empresa (default false).
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaModoSimplesAtivo(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const { data, error } = await supabase
    .from('empresas')
    .select('atendimento_modo_simples')
    .eq('id', cid)
    .maybeSingle()
  if (error) {
    const msg = String(error.message || '')
    if (msg.includes('atendimento_modo_simples') || msg.includes('does not exist')) {
      return false
    }
    throw error
  }
  return !!data?.atendimento_modo_simples
}

module.exports = { empresaModoSimplesAtivo }
