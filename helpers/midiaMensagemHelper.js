/** Limite alinhado ao envio UltraMsg / WhatsApp. */
const MAX_MEDIA_CAPTION_CHARS = 1024

/**
 * Texto persistido em `mensagens.texto` para mídia outbound.
 * Sem legenda do atendente: placeholder interno — nunca o nome do arquivo.
 */
function textoMensagemMidiaParaBanco({ tipo, captionUsuarioTrim, originalname }) {
  const leg = String(captionUsuarioTrim || '').trim()
  if (leg) return leg.slice(0, MAX_MEDIA_CAPTION_CHARS)
  const t = String(tipo || '').toLowerCase()
  if (t === 'audio') return '(áudio)'
  if (t === 'voice') return '(áudio de voz)'
  if (t === 'sticker') return '(figurinha)'
  if (t === 'imagem') return '(imagem)'
  if (t === 'video' || t === 'vídeo') return '(vídeo)'
  return String(originalname || '').trim() || '(arquivo)'
}

/**
 * Caption enviada ao WhatsApp (UltraMsg). Imagem/vídeo/figurinha sem legenda do atendente: vazio.
 * Documentos exigem caption não vazia na API — usa rodapé do atendente ou espaço.
 */
function captionWhatsappParaMidia({ tipo, captionUsuarioTrim, usuarioNome }) {
  const leg = String(captionUsuarioTrim || '').trim()
  const footer = usuarioNome ? `— ${usuarioNome}` : ''
  if (leg) {
    const full = footer ? `${leg}\n${footer}` : leg
    return full.slice(0, MAX_MEDIA_CAPTION_CHARS)
  }
  const t = String(tipo || '').toLowerCase()
  if (t === 'imagem' || t === 'video' || t === 'vídeo' || t === 'sticker') return ''
  return footer || ' '
}

module.exports = {
  MAX_MEDIA_CAPTION_CHARS,
  textoMensagemMidiaParaBanco,
  captionWhatsappParaMidia,
}
