/**
 * Detecção de origem "disparo" a partir do inbound: primeira mensagem externa e presença de inbound.
 * Extraído de controllers/webhookZapiController.js (Fase 4 — doc 24) sem alteração de comportamento.
 * Recebem o supabaseClient por parâmetro.
 */

/**
 * True só se a mensagem inserida for a PRIMEIRA da conversa (por criado_em, id) e for outbound
 * sem autor_usuario_id — critério de envio pelo WhatsApp/celular fora do ZapERP (CRM grava autor).
 */
async function mensagemInseridaEhPrimeiraDisparoWhatsappExterno(supabaseClient, company_id, conversa_id, mensagemIdInserida) {
  if (!supabaseClient || company_id == null || conversa_id == null || mensagemIdInserida == null) return false
  try {
    const { data: first, error } = await supabaseClient
      .from('mensagens')
      .select('id, direcao, autor_usuario_id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .order('criado_em', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn('[webhook] mensagemInseridaEhPrimeiraDisparoWhatsappExterno:', error?.message || error)
      return false
    }
    if (!first?.id || Number(first.id) !== Number(mensagemIdInserida)) return false
    if (String(first.direcao || '') !== 'out') return false
    if (first.autor_usuario_id != null) return false
    return true
  } catch (e) {
    console.warn('[webhook] mensagemInseridaEhPrimeiraDisparoWhatsappExterno exceção:', e?.message || e)
    return false
  }
}

/** True se já existir mensagem inbound na conversa (histórico importado ou respostas do cliente). */
async function conversaTemAlgumaMensagemInbound(supabaseClient, company_id, conversa_id) {
  if (!supabaseClient || company_id == null || conversa_id == null) return false
  try {
    const { count, error } = await supabaseClient
      .from('mensagens')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('direcao', 'in')
    if (error) return false
    return Number(count || 0) > 0
  } catch (e) {
    console.warn('[webhook] conversaTemAlgumaMensagemInbound:', e?.message || e)
    return false
  }
}

module.exports = { mensagemInseridaEhPrimeiraDisparoWhatsappExterno, conversaTemAlgumaMensagemInbound }
