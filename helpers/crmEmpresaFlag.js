const supabase = require('../config/supabase')

/**
 * CRM ativo para a empresa (default true se coluna ausente ou NULL).
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaCrmHabilitada(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const { data, error } = await supabase
    .from('empresas')
    .select('crm_habilitado')
    .eq('id', cid)
    .maybeSingle()
  if (error) {
    const msg = String(error.message || '')
    if (msg.includes('crm_habilitado') || msg.includes('does not exist')) {
      return true
    }
    throw error
  }
  return data?.crm_habilitado !== false
}

module.exports = { empresaCrmHabilitada }
