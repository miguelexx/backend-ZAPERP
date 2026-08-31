/**
 * Mapeamento canônico do resultado do provider WhatsApp (UltraMSG) para o estado da mensagem.
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
 * Regra invariante (idêntica em todos os caminhos):
 *   status  = 'sent'     ← provider aceitou (ok) e retornou ID rastreável (whatsapp_id real)
 *   status  = 'pending'  ← provider aceitou sem ID rastreável (ex.: ID de fila numérico)
 *   status  = 'erro'     ← provider recusou/falhou (ok=false)
 */

const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../../helpers/whatsappMessageIdHelper')

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
  const acceptedWithoutTrace = ok && !hasValidId
  // Regra: sent exige aceite do provider E ID rastreável. Aceite sem ID rastreável permanece
  // pending/sending para evitar mensagem fantasma; o ACK pode chegar depois via webhook/reconciliação.
  const nextStatus = ok ? (hasValidId ? 'sent' : 'pending') : 'erro'
  const nextStatusMensagem = ok ? (hasValidId ? 'sent' : 'sending') : failedStatusMensagem
  return {
    ok,
    waMessageId,
    hasValidId,
    hasQueueId,
    providerError,
    acceptedWithoutTrace,
    nextStatus,
    nextStatusMensagem,
  }
}

module.exports = { mapProviderSendResult }
