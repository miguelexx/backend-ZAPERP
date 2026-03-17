/**
 * Serviço de captura de avaliações (nota 0-10) após finalização de atendimento.
 * Chamado pelo webhook quando o cliente envia mensagem em conversa fechada.
 */

const supabase = require('../config/supabase')

/**
 * Verifica se o texto é uma nota válida (0-10).
 * Aceita: "10", "5", " 8 ", "9" etc.
 */
function parseNota(texto) {
  if (!texto || typeof texto !== 'string') return null
  const t = String(texto).trim()
  if (!/^\d{1,2}$/.test(t)) return null
  const n = parseInt(t, 10)
  if (n >= 0 && n <= 10) return n
  return null
}

/**
 * Tenta registrar a nota de avaliação do cliente.
 * Chamado quando: conversa status_atendimento='fechada', mensagem direcao='in', texto = 0-10.
 *
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {number} opts.conversa_id
 * @param {number} [opts.cliente_id]
 * @param {string} opts.texto - Mensagem do cliente (deve ser 0-10)
 * @returns {Promise<{ registered: boolean, error?: string }>}
 */
async function tentarRegistrarAvaliacao({ company_id, conversa_id, cliente_id, texto }) {
  const nota = parseNota(texto)
  if (nota === null) return { registered: false }

  try {
    // Último atendimento com acao='encerrou' para esta conversa (de_usuario_id = quem atendeu)
    const { data: atend, error: errAt } = await supabase
      .from('atendimentos')
      .select('id, de_usuario_id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('acao', 'encerrou')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (errAt || !atend?.id) return { registered: false }
    const atendente_id = atend.de_usuario_id
    if (!atendente_id) return { registered: false }

    // Inserir avaliação (atendente_id = usuário que atendeu)
    const { error: errIns } = await supabase
      .from('avaliacoes_atendimento')
      .insert({
        company_id,
        atendimento_id: atend.id,
        atendente_id,
        conversa_id,
        cliente_id: cliente_id || null,
        nota
      })

    if (errIns) {
      if (String(errIns.code || '') === '23505') {
        // Já existe avaliação para este atendimento
        return { registered: false }
      }
      console.warn('[avaliacaoService] insert error:', errIns.message)
      return { registered: false, error: errIns.message }
    }

    return { registered: true }
  } catch (e) {
    console.warn('[avaliacaoService] tentarRegistrarAvaliacao:', e?.message || e)
    return { registered: false, error: e?.message }
  }
}

module.exports = {
  parseNota,
  tentarRegistrarAvaliacao,
}
