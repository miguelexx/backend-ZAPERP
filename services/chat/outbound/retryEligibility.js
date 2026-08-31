/**
 * Regras puras de elegibilidade de reenvio de mensagens e extração de legenda persistida.
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 */

const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../../helpers/whatsappMessageIdHelper')

const _STATUS_REENVIO_PERMITIDO = new Set(['erro', 'error', 'failed', 'falhou'])
const _STATUS_JA_RESOLVIDO = new Set(['sent', 'delivered', 'read', 'played', 'enviada', 'entregue', 'lida'])

function statusReenvioNormalizado(mensagem) {
  return String(mensagem?.status_mensagem || mensagem?.status || '').toLowerCase().trim()
}

/**
 * Reenvio só é seguro quando o provedor comprovadamente não aceitou a mensagem.
 * Com whatsapp_id real ou provider_queue_id o WhatsApp já a recebeu: reenviar duplicaria para o cliente.
 */
function avaliarElegibilidadeReenvio(mensagem) {
  if (String(mensagem?.direcao || '').toLowerCase() !== 'out') {
    return { permitido: false, httpStatus: 400, motivo: 'Só é possível reenviar mensagens enviadas pelo atendimento.' }
  }
  if (isRealWhatsAppId(mensagem?.whatsapp_id)) {
    return { permitido: false, jaResolvida: true, motivo: 'Mensagem já confirmada pelo WhatsApp.' }
  }
  if (_STATUS_JA_RESOLVIDO.has(statusReenvioNormalizado(mensagem))) {
    return { permitido: false, jaResolvida: true, motivo: 'Mensagem já enviada.' }
  }
  if (_STATUS_REENVIO_PERMITIDO.has(statusReenvioNormalizado(mensagem))) return { permitido: true }
  // Linhas legadas podem ter o ID de fila gravado em whatsapp_id: também significa provedor que já aceitou.
  const idFilaProvedor =
    String(mensagem?.provider_queue_id || '').trim() ||
    (isUltramsgNumericQueueId(String(mensagem?.whatsapp_id || '').trim())
      ? String(mensagem.whatsapp_id).trim()
      : '')
  if (idFilaProvedor) {
    return {
      permitido: false,
      httpStatus: 409,
      motivo: 'O WhatsApp já recebeu esta mensagem e ainda não confirmou. Aguarde antes de reenviar.',
    }
  }
  return { permitido: true }
}

/** Legenda original do atendente a partir do texto persistido (inverte os placeholders de mídia). */
function captionUsuarioDeMidiaPersistida(mensagem) {
  const texto = String(mensagem?.texto || '').trim()
  if (!texto) return ''
  const placeholders = new Set(['(áudio)', '(áudio de voz)', '(figurinha)', '(imagem)', '(vídeo)', '(arquivo)'])
  if (placeholders.has(texto.toLowerCase())) return ''
  if (texto === String(mensagem?.nome_arquivo || '').trim()) return ''
  return texto
}

module.exports = {
  _STATUS_REENVIO_PERMITIDO,
  _STATUS_JA_RESOLVIDO,
  statusReenvioNormalizado,
  avaliarElegibilidadeReenvio,
  captionUsuarioDeMidiaPersistida,
}
