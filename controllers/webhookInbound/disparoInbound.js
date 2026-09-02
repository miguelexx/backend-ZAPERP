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

/**
 * Etapa 8 Disparo (best-effort, NÃO bloqueia o webhook): agenda opt-out por match exato e o vínculo
 * da resposta inbound ao item de fila. Extraído verbatim de receberZapi (Fase 5 — doc 24). Fire-and-forget
 * via setImmediate; o chamador só invoca quando `!fromMe && !isGroup && mensagem inserida pelo webhook`.
 * Requires dinâmicos mantidos (quebram um ciclo potencial e adiam o custo para fora do caminho quente).
 */
function scheduleInboundDisparoHooks({ companyId, telefone, texto, mensagemId, conversaId, instanciaId, io }) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        try {
          const { processInboundOptOut } = require('../../services/disparoOptOutService')
          await processInboundOptOut({
            companyId,
            telefone,
            texto,
            mensagemId,
            conversaId,
            instanciaId,
            io,
          })
        } catch (e) {
          console.warn('[disparo:optout] hook:', e?.message || e)
        }
        try {
          const { vincularRespostaInbound } = require('../../services/disparoRespostaService')
          await vincularRespostaInbound({
            companyId,
            telefone,
            mensagemId,
            conversaId,
            instanciaId,
            io,
          })
        } catch (e) {
          console.warn('[disparo:resposta] hook:', e?.message || e)
        }
      })
      .catch(() => {})
  })
}

module.exports = { mensagemInseridaEhPrimeiraDisparoWhatsappExterno, conversaTemAlgumaMensagemInbound, scheduleInboundDisparoHooks }
