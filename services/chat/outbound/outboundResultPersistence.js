/**
 * Grava no banco o resultado de um envio ao provedor (status + ids), com duas garantias que as
 * gravações diretas nos controllers não tinham:
 *
 *  1. NÃO REBAIXA. O ACK ou o eco do provedor pode chegar antes desta gravação e já ter levado
 *     a linha a sent/delivered/read. Gravar "pending/sending" (ou "sent") por cima devolvia a
 *     bolha ao relógio, e o ACK que a corrigiria já tinha sido consumido. Aqui o status só é
 *     escrito se a linha ainda estiver em pending/sending/erro; caso contrário grava só os ids.
 *
 *  2. CONFERE O ERRO. supabase-js não lança: uma falha (ex.: o eco já reivindicou o whatsapp_id,
 *     índice único) passava despercebida — a tela recebia "enviada" + id e o banco ficava pending
 *     sem id. Aqui a falha é devolvida ao chamador, que agenda a reconciliação.
 */

const supabase = require('../../../config/supabase')

/** Status a partir dos quais a linha ainda aceita o resultado do envio. */
const STATUS_AINDA_ABERTOS = ['pending', 'sending', 'erro', 'failed']

/**
 * @param {object} p
 * @param {number} p.company_id
 * @param {number} p.mensagem_id
 * @param {string} p.status
 * @param {string} p.status_mensagem
 * @param {string|null} [p.whatsapp_id]        id real do WhatsApp (rastreável)
 * @param {string|null} [p.provider_queue_id]  id de fila do provedor
 * @returns {Promise<{ ok: boolean, jaAvancada?: boolean, idsGravados: boolean, erro?: string }>}
 */
async function gravarResultadoDoEnvio({ company_id, mensagem_id, status, status_mensagem, whatsapp_id = null, provider_queue_id = null }) {
  const ids = {
    ...(whatsapp_id ? { whatsapp_id } : {}),
    ...(provider_queue_id ? { provider_queue_id } : {}),
  }
  const temIds = Object.keys(ids).length > 0
  const base = () => supabase.from('mensagens')

  const { data, error } = await base()
    .update({ status, status_mensagem, ...ids })
    .eq('company_id', company_id)
    .eq('id', mensagem_id)
    .in('status', STATUS_AINDA_ABERTOS)
    .select('id')

  if (error) {
    // Falhou com os ids (tipicamente índice único do whatsapp_id): garante ao menos o status.
    const { error: erroStatus } = await base()
      .update({ status, status_mensagem })
      .eq('company_id', company_id)
      .eq('id', mensagem_id)
      .in('status', STATUS_AINDA_ABERTOS)
    return { ok: !erroStatus, idsGravados: false, erro: error.message || String(error) }
  }

  if (Array.isArray(data) && data.length > 0) return { ok: true, idsGravados: temIds }

  // Nenhuma linha "aberta": o ACK/eco já avançou o status. Preserva-o e grava só os ids.
  if (temIds) {
    const { error: erroIds } = await base()
      .update(ids)
      .eq('company_id', company_id)
      .eq('id', mensagem_id)
    if (erroIds) return { ok: true, jaAvancada: true, idsGravados: false, erro: erroIds.message || String(erroIds) }
  }
  return { ok: true, jaAvancada: true, idsGravados: temIds }
}

module.exports = { gravarResultadoDoEnvio, STATUS_AINDA_ABERTOS }
