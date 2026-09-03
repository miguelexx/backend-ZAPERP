const supabase = require('../config/supabase')

/**
 * Módulo "Separar mensagens disparadas" ativo para a empresa (default false).
 * Espelha o padrão de helpers/empresaModoSimplesFlag.js — tolera coluna ausente sem derrubar o fluxo.
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaSeparaMensagensDisparadas(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const { data, error } = await supabase
    .from('empresas')
    .select('separar_mensagens_disparadas')
    .eq('id', cid)
    .maybeSingle()
  if (error) {
    const msg = String(error.message || '')
    if (msg.includes('separar_mensagens_disparadas') || msg.includes('does not exist')) return false
    return false
  }
  return !!data?.separar_mensagens_disparadas
}

module.exports = { empresaSeparaMensagensDisparadas }
