/**
 * Módulo de proteção: intervalo mínimo entre mensagens por contato.
 * Opcional — falha não impede envio. Ativado por FEATURE_PROTECAO.
 */

const supabase = require('../../config/supabase')

/**
 * Verifica se respeita intervalo mínimo desde última mensagem enviada ao contato.
 * @param {number} company_id
 * @param {number} conversa_id
 * @param {number} intervaloMinSegundos - empresas.intervalo_minimo_entre_mensagens_seg
 * @returns {Promise<{ ok: boolean, ultimaEnvio?: string }>}
 */
async function verificarIntervalo(company_id, conversa_id, intervaloMinSegundos) {
  if (!company_id || !conversa_id) return { ok: true }
  if (!intervaloMinSegundos || intervaloMinSegundos <= 0) return { ok: true }

  const desde = new Date(Date.now() - intervaloMinSegundos * 1000).toISOString()
  const { data } = await supabase
    .from('mensagens')
    .select('criado_em')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('direcao', 'out')
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(1)
  const ultima = data?.[0]?.criado_em
  return { ok: !ultima, ultimaEnvio: ultima }
}

module.exports = { verificarIntervalo }
