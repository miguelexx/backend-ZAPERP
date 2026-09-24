/**
 * Marca uma mensagem como "apagada pelo cliente" (revogação "para todos" feita pelo CONTATO),
 * mantendo o conteúdo original visível — só liga o aviso de auditoria + emite o socket.
 *
 * Provider-agnóstico: recebe apenas o tenant + o whatsapp_id da mensagem-alvo. É a mesma
 * regra usada pelo webhook Whapi (applyWhapiDeletedMessage), extraída para ser reaproveitada
 * pelo inbound UltraMSG sem duplicar a lógica de banco/idempotência.
 *
 * Idempotente: se a linha já está apagada (por nós ou pelo cliente), não sobrescreve.
 */

const supabase = require('../../../config/supabase')
const { emitirEventoEmpresaConversa } = require('../realtime/chatRealtimeGateway')

async function markClientDeletedMessage({ company_id, whatsapp_instance_id } = {}, targetWhatsappId, io) {
  if (company_id == null) return false
  const targetId = targetWhatsappId != null ? String(targetWhatsappId).trim() : ''
  if (!targetId) return false

  const findRow = async ({ withInstance }) => {
    let query = supabase
      .from('mensagens')
      .select('id, conversa_id, apagada_pelo_cliente, apagada_para_todos')
      .eq('company_id', company_id)
      .eq('whatsapp_id', targetId)
    if (withInstance && whatsapp_instance_id) {
      query = query.eq('whatsapp_instance_id', whatsapp_instance_id)
    }
    return query.order('id', { ascending: false }).limit(1).maybeSingle()
  }

  let { data: row, error } = await findRow({ withInstance: true })
  if ((!row?.id || error) && whatsapp_instance_id) {
    // Fallback: linha legada sem whatsapp_instance_id / divergência de instância.
    ;({ data: row, error } = await findRow({ withInstance: false }))
  }
  if (error || !row?.id) return false
  // Já revogada por nós (apagada_para_todos) ou já marcada: não sobrescreve (idempotência).
  if (row.apagada_para_todos === true || row.apagada_pelo_cliente === true) return true

  const apagadaEm = new Date().toISOString()
  const { error: errUpd } = await supabase
    .from('mensagens')
    .update({ apagada_pelo_cliente: true, apagada_pelo_cliente_em: apagadaEm })
    .eq('company_id', company_id)
    .eq('id', row.id)
  if (errUpd) {
    const msg = String(errUpd.message || '')
    if (msg.includes('apagada_pelo_cliente') || msg.includes('does not exist')) {
      console.warn('[deletion] coluna apagada_pelo_cliente ausente — rode a migration 20260921120000.')
    } else {
      console.warn('[deletion] marcar apagada_pelo_cliente falhou:', errUpd.message)
    }
    return false
  }

  if (io) {
    emitirEventoEmpresaConversa(io, company_id, row.conversa_id, 'mensagem_apagada_cliente', {
      conversa_id: row.conversa_id,
      mensagem_id: row.id,
      company_id,
      apagada_pelo_cliente_em: apagadaEm,
    })
  }
  return true
}

module.exports = { markClientDeletedMessage }
