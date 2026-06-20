/**
 * Regras automáticas no webhook: palavra-chave → resposta.
 * Chamado antes do chatbot — complementar, não invasivo.
 * Respeita horario_comercial_only e ia_config.config.regras_automaticas.enabled.
 */

const supabase = require('../config/supabase')

function isWithinBusinessHours(empresa, now = new Date()) {
  if (!empresa?.horario_inicio || !empresa?.horario_fim) return true
  const [hIni, mIni] = String(empresa.horario_inicio).split(':').map(Number)
  const [hFim, mFim] = String(empresa.horario_fim).split(':').map(Number)
  const minutosAgora = now.getHours() * 60 + now.getMinutes()
  const minutosIni = hIni * 60 + (mIni || 0)
  const minutosFim = hFim * 60 + (mFim || 0)
  if (minutosIni <= minutosFim) return minutosAgora >= minutosIni && minutosAgora <= minutosFim
  return minutosAgora >= minutosIni || minutosAgora <= minutosFim
}

/**
 * Processa regras automáticas.
 * @param {object} ctx
 * @param {object} ctx.supabase
 * @param {number} ctx.company_id
 * @param {number} ctx.conversa_id
 * @param {string} ctx.texto
 * @param {function} ctx.sendMessage(phone, msg)
 * @returns {Promise<{ matched: boolean, respostaEnviada?: boolean }>}
 */
async function processarRegras(ctx) {
  const { supabase: supabaseClient, company_id, conversa_id, texto, sendMessage } = ctx
  if (!company_id || !texto || typeof texto !== 'string' || !sendMessage) return { matched: false }

  try {
    const { data: iaConfig } = await supabaseClient
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()

    const enabled = iaConfig?.config?.regras_automaticas?.enabled
    if (enabled !== true) return { matched: false }

    const { data: regras } = await supabaseClient
      .from('regras_automaticas')
      .select('id, palavra_chave, resposta, departamento_id, tag_id, aplicar_tag, horario_comercial_only')
      .eq('company_id', company_id)
      .eq('ativo', true)
      .order('id', { ascending: true })

    if (!regras || regras.length === 0) return { matched: false }

    let { data: empresa } = await supabaseClient
      .from('empresas')
      .select('horario_inicio, horario_fim')
      .eq('id', company_id)
      .maybeSingle()

    const textoLower = String(texto).trim().toLowerCase()
    const now = new Date()

    for (const r of regras) {
      const kw = String(r.palavra_chave || '').trim().toLowerCase()
      if (!kw) continue
      if (!textoLower.includes(kw)) continue
      if (r.horario_comercial_only && !isWithinBusinessHours(empresa || {}, now)) continue

      const resposta = String(r.resposta || '').trim()
      if (!resposta) continue

      const telefone = ctx.telefone
      if (!telefone) continue

      try {
        await sendMessage(telefone, resposta, {})
        await supabaseClient.from('bot_logs').insert({
          company_id,
          conversa_id,
          tipo: 'regra_automatica',
          detalhes: { regra_id: r.id, palavra_chave: r.palavra_chave },
        }).catch(() => {})

        if (r.departamento_id) {
          await supabaseClient.from('conversas')
            .update({ departamento_id: r.departamento_id })
            .eq('id', conversa_id)
            .eq('company_id', company_id)
        }
        if (r.tag_id && r.aplicar_tag) {
          const { data: existente } = await supabaseClient.from('conversa_tags')
            .select('id')
            .eq('conversa_id', conversa_id)
            .eq('tag_id', r.tag_id)
            .eq('company_id', company_id)
            .maybeSingle()
          if (!existente) {
            await supabaseClient.from('conversa_tags').insert({
              conversa_id,
              tag_id: r.tag_id,
              company_id,
            }).catch(() => {})
          }
        }
        return { matched: true, respostaEnviada: true }
      } catch (e) {
        console.warn('[regrasAutomaticas] Erro ao enviar:', e?.message || e)
      }
    }
    return { matched: false }
  } catch (e) {
    console.warn('[regrasAutomaticas] Erro:', e?.message || e)
    return { matched: false }
  }
}

module.exports = { processarRegras, isWithinBusinessHours }
