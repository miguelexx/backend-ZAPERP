/**
 * Persistência da mensagem inbound — parte PURA (montagem de campos). Extraído verbatim de receberZapi
 * (Fase 5 — doc 24). O `insert` real + retries + tratamento de `23505` seguem no orquestrador; aqui fica
 * só o mapeamento determinístico `type/mídia → campos do row` (tipo, url, nome_arquivo, metas).
 *
 * `applyInboundMediaFields(insertMsg, media)` MUTA e devolve o `insertMsg`. Único efeito colateral: um
 * `console.warn` diagnóstico quando um áudio chega sem URL de mídia (comportamento preservado).
 */

function applyInboundMediaFields(insertMsg, media) {
  const {
    type, imageUrl, documentUrl, audioUrl, videoUrl, stickerUrl,
    locationUrl, locationMeta, contactMeta, fileName, diag = {},
  } = media || {}

  if (type === 'image' && imageUrl) {
    insertMsg.tipo = 'imagem'
    insertMsg.url = imageUrl
    insertMsg.nome_arquivo = fileName || 'imagem.jpg'
  } else if ((type === 'document' || type === 'file') && documentUrl) {
    insertMsg.tipo = 'arquivo'
    insertMsg.url = documentUrl
    insertMsg.nome_arquivo = fileName || 'arquivo'
  } else if (type === 'audio' || type === 'ptt') {
    insertMsg.tipo = type === 'ptt' ? 'voice' : 'audio'
    if (audioUrl) {
      insertMsg.url = audioUrl
      insertMsg.nome_arquivo = fileName || (type === 'ptt' ? 'voice.ogg' : 'audio')
    } else {
      console.warn('[webhook] áudio inbound sem URL de mídia:', {
        company_id: diag.company_id,
        conversa_id: diag.conversa_id,
        whatsapp_id: diag.whatsapp_id ?? null,
        whatsapp_instance_id: diag.whatsapp_instance_id ?? null,
        type,
        fromMe: diag.fromMe,
        fileName: fileName || null,
        hasImageUrl: !!imageUrl,
        hasDocumentUrl: !!documentUrl,
        hasVideoUrl: !!videoUrl,
        hasStickerUrl: !!stickerUrl,
      })
    }
  } else if (type === 'video' && videoUrl) {
    insertMsg.tipo = 'video'
    insertMsg.url = videoUrl
    insertMsg.nome_arquivo = fileName || 'video'
  } else if (type === 'sticker' && stickerUrl) {
    insertMsg.tipo = 'sticker'
    insertMsg.url = stickerUrl
    insertMsg.nome_arquivo = fileName || 'sticker.webp'
  } else if (type === 'location') {
    insertMsg.tipo = 'location'
    if (locationUrl) insertMsg.url = locationUrl
    insertMsg.nome_arquivo = 'localização'
    if (locationMeta && (locationMeta.latitude != null || locationMeta.longitude != null)) {
      insertMsg.location_meta = locationMeta
    }
  } else if (type === 'contact') {
    insertMsg.tipo = 'contact'
    if (contactMeta && (contactMeta.nome || contactMeta.telefone)) {
      insertMsg.contact_meta = contactMeta
    }
  } else if (type === 'reaction') {
    insertMsg.tipo = 'reaction'
  }
  // Demais tipos: já têm texto preenchido; tipo padrão é texto (não seta insertMsg.tipo).
  return insertMsg
}

module.exports = { applyInboundMediaFields }
