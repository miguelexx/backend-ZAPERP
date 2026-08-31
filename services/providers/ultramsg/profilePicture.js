const { WHATSAPP_DEBUG } = require('./constants')
const { profilePictureChatIdCandidates } = require('./phones')
const { resolveConfig } = require('./config')
const { get } = require('./http')

// Cache para contatos sem foto (evita requisições repetidas)
const noProfilePictureCache = new Map()
// B09: 1h (antes 24h) — permite nova tentativa se o contato passar a ter foto
const NO_PICTURE_CACHE_TTL = 60 * 60 * 1000

// Rate limiting para requisições de foto de perfil
const profilePictureRateLimit = new Map()
const PROFILE_PICTURE_RATE_LIMIT_MS = 2000 // 2 segundos entre requisições por instância

/**
 * Invalida cache “sem foto” para um chatId/telefone (ex.: ao abrir conversa / refresh).
 * Aceita chatId completo ou dígitos; remove chaves que terminam com o chatId normalizado.
 */
function invalidateNoProfilePictureCache(chatIdOrPhone) {
  const raw = String(chatIdOrPhone || '').trim()
  if (!raw) return false
  const chatIds = profilePictureChatIdCandidates(raw, raw.includes('@') ? { chatId: raw } : {})
  if (chatIds.length === 0) return false
  let removed = false
  for (const key of [...noProfilePictureCache.keys()]) {
    if (chatIds.some((chatId) => key === chatId || key.endsWith(`:${chatId}`))) {
      noProfilePictureCache.delete(key)
      removed = true
    }
  }
  return removed
}

// Limpeza periódica dos caches (a cada 6 horas)
const cacheCleanupInterval = setInterval(() => {
  const now = Date.now()
  
  // Limpar cache de contatos sem foto expirados
  for (const [key, value] of noProfilePictureCache.entries()) {
    if (value.expiry <= now) {
      noProfilePictureCache.delete(key)
    }
  }
  
  // Limpar rate limit antigo (mais de 1 hora)
  for (const [key, timestamp] of profilePictureRateLimit.entries()) {
    if (now - timestamp > 60 * 60 * 1000) {
      profilePictureRateLimit.delete(key)
    }
  }
  
  if (WHATSAPP_DEBUG) {
    console.log('[ULTRAMSG] Cache cleanup completed', {
      noPictureCache: noProfilePictureCache.size,
      rateLimitCache: profilePictureRateLimit.size
    })
  }
}, 6 * 60 * 60 * 1000) // 6 horas
if (cacheCleanupInterval && typeof cacheCleanupInterval.unref === 'function') {
  cacheCleanupInterval.unref()
}

async function awaitProfilePictureRateLimit(cfg) {
  const rateLimitKey = `rate_limit:${cfg.instanceId || cfg.companyId || 'default'}`
  const lastRequest = profilePictureRateLimit.get(rateLimitKey)
  const now = Date.now()
  if (lastRequest && (now - lastRequest) < PROFILE_PICTURE_RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, PROFILE_PICTURE_RATE_LIMIT_MS - (now - lastRequest)))
  }
  profilePictureRateLimit.set(rateLimitKey, Date.now())
}

async function fetchProfilePictureForChatId(cfg, chatId) {
  const cacheKey = `${cfg.instanceId || cfg.companyId || 'default'}:${chatId}`
  const cachedNoPhoto = noProfilePictureCache.get(cacheKey)
  if (cachedNoPhoto && cachedNoPhoto.expiry > Date.now()) return null

  await awaitProfilePictureRateLimit(cfg)

  try {
    const { ok, data, text } = await get({
      ...cfg,
      endpoint: '/contacts/image',
      extraParams: { chatId }
    })

    const isNoPhotoError = data?.error && (
      data.error.includes("don't have picture") ||
      data.error.includes("not in your chat list") ||
      data.error.includes("user not found")
    )

    if (isNoPhotoError) {
      noProfilePictureCache.set(cacheKey, { expiry: Date.now() + NO_PICTURE_CACHE_TTL })
      if (WHATSAPP_DEBUG) {
        console.log('[ULTRAMSG] No profile picture:', chatId.slice(-12))
      }
      return null
    }

    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getProfilePicture', { chatId: chatId.slice(-12), ok, status: data?.error ?? 'ok' })
    }
    if (!ok) return null
    let url = null
    if (data && typeof data === 'object') {
      url = data.success ?? data.url ?? data.image ?? data.img ?? data.profilePicture ?? data.profilePic ?? data.link ?? null
    }
    if (!url && typeof text === 'string' && text.trim().startsWith('http')) url = text.trim()
    return url && typeof url === 'string' ? url.trim() : null
  } catch {
    return null
  }
}

/**
 * Busca URL da foto de perfil.
 * Doc oficial: GET /{instance_id}/contacts/image?token={TOKEN}&chatId={chatId}
 * NÃO usa phoneToChatId (formato de envio com 9º dígito) — isso buscava outro JID.
 */
async function getProfilePicture(phoneOrChatId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null

  const candidates = profilePictureChatIdCandidates(phoneOrChatId, opts)
  if (candidates.length === 0) return null

  for (const chatId of candidates) {
    const url = await fetchProfilePictureForChatId(cfg, chatId)
    if (url) return url
  }
  return null
}

module.exports = {
  getProfilePicture,
  invalidateNoProfilePictureCache,
}
