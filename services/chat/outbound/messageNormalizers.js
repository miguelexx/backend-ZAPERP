/**
 * Normalizadores puros de payload de mensagens de saída (link e tipo de encaminhamento).
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 */

function normalizeLinkPayload(link) {
  if (!link || typeof link !== 'object') return null
  const linkUrl = String(link.linkUrl ?? link.url ?? '').trim()
  if (!linkUrl) return null
  return {
    ...link,
    linkUrl,
    title: String(link.title || '').trim(),
    image: link.image || '',
    linkDescription: String(link.linkDescription || link.description || '').trim(),
  }
}

function normalizeForwardTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim()
  if (t === 'image' || t === 'foto' || t === 'photo') return 'imagem'
  if (t === 'vídeo') return 'video'
  if (t === 'document' || t === 'documento' || t === 'file' || t === 'pdf') return 'arquivo'
  if (t === 'ptt') return 'voice'
  return t || 'texto'
}

module.exports = {
  normalizeLinkPayload,
  normalizeForwardTipo,
}
