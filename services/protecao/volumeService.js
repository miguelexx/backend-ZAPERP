/**
 * Módulo de proteção: limite de envios por minuto/hora por empresa.
 * Opcional — falha não impede envio. Ativado por FEATURE_PROTECAO.
 */

const supabase = require('../../config/supabase')

/**
 * Verifica se empresa está dentro do limite de envios no período.
 * @param {number} company_id
 * @param {number} limitePorMinuto
 * @param {number} limitePorHora
 * @returns {Promise<{ ok: boolean, countMin?: number, countHora?: number }>}
 */
async function verificarLimiteVolume(company_id, limitePorMinuto, limitePorHora) {
  if (!company_id) return { ok: true }
  const now = new Date()
  const umMinAtras = new Date(now.getTime() - 60 * 1000).toISOString()
  const umaHoraAtras = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

  let countMin = 0
  let countHora = 0

  if (limitePorMinuto && limitePorMinuto > 0) {
    const { count } = await supabase
      .from('mensagens')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('direcao', 'out')
      .gte('criado_em', umMinAtras)
    countMin = typeof count === 'number' ? count : 0
    if (countMin >= limitePorMinuto) return { ok: false, countMin, countHora }
  }

  if (limitePorHora && limitePorHora > 0) {
    const { count } = await supabase
      .from('mensagens')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('direcao', 'out')
      .gte('criado_em', umaHoraAtras)
    countHora = typeof count === 'number' ? count : 0
    if (countHora >= limitePorHora) return { ok: false, countMin, countHora }
  }

  return { ok: true, countMin, countHora }
}

module.exports = { verificarLimiteVolume }
