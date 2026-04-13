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
  return out
}

module.exports = {
  getPublicApiBase,
  resolvePublicMediaUrl,
  enrichInternalChatMessageRow,
}
