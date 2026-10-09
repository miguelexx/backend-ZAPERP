/**
 * Mapeamento canônico do resultado do provider WhatsApp para o estado da mensagem.
 *
 * Extraído de controllers/chatController.js (Fase 2 da modularização). Hoje essa mesma máquina de
 * estados aparece inline e DUPLICADA em vários endpoints de saída (texto, contato, localização,
 * ligação, mídia, encaminhamento). Este módulo é a fonte única; a migração dos endpoints para
 * consumi-lo é uma etapa posterior (Fase 6), pois cada caminho tem persistência/socket próprios.
 *
 * DIVERGÊNCIA CONHECIDA a preservar (P0 #1 do doc de modularização): o status_mensagem em caso de
 * falha difere entre caminhos — `enviarMensagemChat` (texto) grava `'failed'`, enquanto contato,
 * localização, ligação, mídia e encaminhamento gravam `'erro'`. Por isso o status de falha é
 * parametrizável (`failedStatusMensagem`), com default `'erro'` (a maioria). Unificar esse valor é
 * uma decisão de comportamento para a Fase 6, não parte desta extração estrutural.
 *
 * Regra invariante:
 *   status  = 'sent'     ← provider confirmou envio; na Whapi isso exige ACK `sent` ou superior
 *   status  = 'pending'  ← provider aceitou sem ID rastreável (ex.: ID de fila numérico)
 *   status  = 'erro'     ← provider recusou/falhou (ok=false)
 */

const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../../helpers/whatsappMessageIdHelper')
const { isTransientOutboundFailure } = require('./outboundFailureClassifier')

/**
 * @param {boolean|object} result Resultado bruto do provider (boolean legado ou objeto {ok, messageId, error, blockedBy}).
 * @param {object} [opts]
 * @param {string} [opts.failedStatusMensagem='erro'] status_mensagem a gravar quando ok=false.
 * @returns {{
 *   ok: boolean,
 *   waMessageId: string|null,
 *   hasValidId: boolean,
 *   hasQueueId: boolean,
 *   providerError: any,
 *   acceptedWithoutTrace: boolean,
 *   needsReconciliation: boolean,
 *   nextStatus: 'sent'|'pending'|'erro',
 *   nextStatusMensagem: string,
 * }}
 */
function mapProviderSendResult(result, opts = {}) {
  const failedStatusMensagem = opts.failedStatusMensagem || 'erro'
  const ok = typeof result === 'boolean' ? result : result?.ok === true
  const waMessageId = typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
  // hasValidId: ID reconhecível como WhatsApp real (hex 12+ chars ou contém @).
  // Usado apenas para salvar whatsapp_id e habilitar rastreamento de ACK; NÃO determina sucesso.
  const hasValidId = isRealWhatsAppId(waMessageId)
  const hasQueueId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
  const providerError = (typeof result === 'object') ? (result?.error || result?.blockedBy || null) : null
  const requiresAck = typeof result === 'object' && (
    String(result?.provider || '').toLowerCase() === 'whapi' || result?.ackConfirmed === false
  )
  const ackConfirmed = !requiresAck || result?.ackConfirmed === true
  const confirmedSent = hasValidId && ackConfirmed
  const awaitingAck = ok && hasValidId && !ackConfirmed
  const acceptedWithoutTrace = ok && !hasValidId
  const needsReconciliation = ok && !confirmedSent
  // O ID Whapi e persistido para reconciliacao, mas nao prova envio. Enquanto
  // nao houver ACK, a mensagem continua pending/sending.
  const nextStatus = ok ? (confirmedSent ? 'sent' : 'pending') : 'erro'
  const nextStatusMensagem = ok ? (confirmedSent ? 'sent' : 'sending') : failedStatusMensagem
  return {
    ok,
    waMessageId,
    hasValidId,
    hasQueueId,
    providerError,
    requiresAck,
    ackConfirmed,
    awaitingAck,
    confirmedSent,
    acceptedWithoutTrace,
    needsReconciliation,
    nextStatus,
    nextStatusMensagem,
  }
}

/**
 * mapProviderSendResult + classificação de falha TRANSITÓRIA num passo só.
 * Timeout/rede/429/5xx não provam que nada foi enviado: a linha fica pending/sending com
 * reconciliação, em vez de 'erro' (que tira a linha da varredura e convida a um reenvio manual
 * capaz de duplicar no cliente). `falhaTransitoria` avisa o chamador para não responder erro.
 */
function mapProviderSendResultComTransitoria(result, opts = {}) {
  const mapped = mapProviderSendResult(result, opts)
  const falhaTransitoria = !mapped.ok && isTransientOutboundFailure({
    httpStatus: typeof result === 'object' ? result?.httpStatus : null,
    transportError: typeof result === 'object' && result?.transportError === true,
  })
  if (!falhaTransitoria) return { ...mapped, falhaTransitoria: false }
  return {
    ...mapped,
    falhaTransitoria: true,
    needsReconciliation: true,
    nextStatus: 'pending',
    nextStatusMensagem: 'sending',
  }
}

/**
 * Executa um envio ao provedor sem deixar a exceção escapar. O adapter UltraMSG PROPAGA
 * timeout/rede; nos endpoints sem try/catch próprio isso virava HTTP 500 com a linha pending
 * órfã (sem evento na tela e sem reconciliação agendada).
 */
async function enviarSemEstourar(fn, acao = 'enviar') {
  try {
    return await fn()
  } catch (e) {
    console.warn(`[ENVIO] exceção de transporte ao ${acao} — tratada como falha transitória:`, e?.message || e)
    return {
      ok: false,
      messageId: null,
      transportError: true,
      error: `Falha de conexão ao ${acao}: ${e?.message || e}`,
    }
  }
}

module.exports = { mapProviderSendResult, mapProviderSendResultComTransitoria, enviarSemEstourar }
