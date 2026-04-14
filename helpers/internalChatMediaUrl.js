/**
 * URLs públicas de mídia do chat interno (/uploads/...).
 * O front em outra origem (ex.: Vite :5173) não resolve caminho relativo para o API (:3000);
 * expomos URL absoluta nas respostas e no socket usando APP_URL / BASE_URL.
 */

/**
 * @returns {string}
 */
function getPublicApiBase() {
  const raw = process.env.APP_URL || process.env.BASE_URL || ''
  return String(raw).trim().replace(/\/$/, '')
}

/**
 * @param {string|null|undefined} mediaUrl
 * @returns {string|null|undefined}
 */
function resolvePublicMediaUrl(mediaUrl) {
  if (mediaUrl == null || mediaUrl === '') return mediaUrl
  const u = String(mediaUrl).trim()
  if (/^https?:\/\//i.test(u)) return u
  const base = getPublicApiBase()
  if (!base) return u
  if (u.startsWith('/')) return `${base}${u}`
  return u
}

/**
 * Clona a linha de mensagem e define `media_url` absoluta quando aplicável.
 * @param {object|null|undefined} row
 * @returns {object|null|undefined}
 */
function enrichInternalChatMessageRow(row) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  if (out.media_url != null) {
    out.media_url = resolvePublicMediaUrl(out.media_url)
  }
  // Compatibilidade retroativa com consumidores legados do painel.
  if (out.url == null) out.url = out.media_url ?? null
  if (out.tipo == null && out.message_type != null) out.tipo = out.message_type
  if (out.texto == null && out.content != null) out.texto = out.content

  if (out.payload && typeof out.payload === 'object') {
    const p = { ...out.payload }
    // Novo canônico: payload.contacts[]. Legado: payload.contact.
    if (!Array.isArray(p.contacts) && p.contact && typeof p.contact === 'object') {
      p.contacts = [p.contact]
    }
    if ((p.contact == null || typeof p.contact !== 'object') && Array.isArray(p.contacts) && p.contacts.length > 0) {
      p.contact = p.contacts[0]
    }
    if ((p.name == null || String(p.name).trim() === '') && p.contact && typeof p.contact === 'object') {
      p.name = p.contact.name ?? null
    }
    if ((p.phone == null || String(p.phone).trim() === '') && p.contact && typeof p.contact === 'object') {
      p.phone = p.contact.phone ?? null
    }
    out.payload = p
  }
  return out
}

module.exports = {
  getPublicApiBase,
  resolvePublicMediaUrl,
  enrichInternalChatMessageRow,
}
