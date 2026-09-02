/**
 * Resolução de status ACK do webhook — parte PURA. Extraído verbatim de receberZapi (Fase 5 — doc 24).
 *
 * `resolveEffectiveStatus(current, next)`: decide o status resultante SEM permitir REGRESSÃO — um ACK
 * atrasado (ex. `sent` chegando depois de `read`) nunca rebaixa o status já registrado. `erro`/`failed`
 * só sobrescrevem enquanto a mensagem ainda não passou de `delivered` (falha tardia não apaga entrega/leitura).
 * Invariante crítico: ver [24](../../docs/ai-handoff/24-WEBHOOK-INBOUND-MODULARIZACAO.md) §4 (ACK sem regressão).
 */

const { statusRank } = require('../../helpers/messageStatusHelper')
const { selectSingleMensagemByWhatsappId, patchMensagemStatusById } = require('./whatsappIdLookup')

function resolveEffectiveStatus(current, next) {
  const currentStatus = current || 'pending'
  if (next === 'erro' || next === 'failed') {
    return statusRank(currentStatus) >= statusRank('delivered') ? currentStatus : next
  }
  return statusRank(currentStatus) > statusRank(next) ? currentStatus : next
}

/**
 * Atualiza o status da mensagem por `whatsapp_id` sem permitir regressão de ACK atrasado (localiza por
 * whatsapp_id + instância, aplica `resolveEffectiveStatus`, faz o patch). NÃO emite socket — o chamador
 * emite `status_mensagem`. `ctx` = `{ company_id, whatsapp_instance_id }` do payload em processamento.
 * Com `opts.returnResult=true` devolve `{ data, error, ambiguous, effectiveStatus }`; senão a linha ou null.
 */
async function applyAckStatusByWaId(supabaseClient, { company_id, whatsapp_instance_id }, waId, statusNorm, opts = {}) {
  const returnResult = opts?.returnResult === true
  const emptyResult = { data: null, error: null, ambiguous: false, effectiveStatus: statusNorm || null }
  if (!waId || !statusNorm) return returnResult ? emptyResult : null
  const waIdStr = String(waId)
  const statusSelect = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, autor_usuario_id, status, status_mensagem'
  const found = await selectSingleMensagemByWhatsappId(supabaseClient, {
    company_id,
    whatsapp_id: waIdStr,
    whatsapp_instance_id,
    select: statusSelect,
    context: opts?.context || 'receberZapi.status',
  })
  if (found.error || !found.data?.id) {
    const result = { ...emptyResult, error: found.error || null, ambiguous: Boolean(found.ambiguous) }
    return returnResult ? result : null
  }

  const currentStatus = found.data.status || found.data.status_mensagem || 'pending'
  const effectiveStatus = resolveEffectiveStatus(currentStatus, statusNorm)
  const { data: msg, error } = await patchMensagemStatusById(supabaseClient, {
    company_id,
    mensagem_id: found.data.id,
    effectiveStatus,
    whatsapp_id: waIdStr,
    select: statusSelect,
  })
  if (msg) msg.whatsapp_id = msg.whatsapp_id || waIdStr
  if (msg) msg._effective_status = effectiveStatus
  const result = { data: msg || null, error: error || null, ambiguous: false, effectiveStatus }
  return returnResult ? result : msg || null
}

module.exports = { resolveEffectiveStatus, applyAckStatusByWaId }
