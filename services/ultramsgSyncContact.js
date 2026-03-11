/**
 * Sincronização de contato com UltraMsg: busca nome e foto reais do WhatsApp.
 * Usado ao receber mensagem e ao criar cliente.
 * Cache 5 min por (phone, company) para evitar excesso de chamadas (anti-bloqueio).
 */

const { getProvider } = require('./providers')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

function cacheKey(phone, companyId) {
  const p = String(phone || '').replace(/\D/g, '').slice(-11)
  return `${companyId ?? 0}:${p}`
}

/**
 * Busca os dados do contato (metadata + foto) e devolve objeto para salvar em clientes.
 */
async function syncContactFromUltramsg(phone, companyId) {
  const key = cacheKey(phone, companyId)
  const cached = cache.get(key)
  if (cached && cached.exp > Date.now()) return cached.data

  const provider = getProvider()
  if (!provider?.getContactMetadata && !provider?.getProfilePicture) return null
  if (companyId != null) {
    const { config } = await getEmpresaWhatsappConfig(companyId)
    if (!config) return null
  }
  const opts = companyId != null ? { companyId } : {}

  const [metadata, profilePicUrl] = await Promise.all([
    provider.getContactMetadata?.(phone, opts).catch(() => null) ?? null,
    provider.getProfilePicture?.(phone, opts).catch(() => null) ?? null
  ])

  if (!metadata && !profilePicUrl) return null

  const notify = metadata?.notify ? String(metadata.notify).trim() : null
  const name = metadata?.name ? String(metadata.name).trim() : null
  const short = metadata?.short ? String(metadata.short).trim() : null
  const vname = metadata?.vname ? String(metadata.vname).trim() : null
  const imgUrl = metadata?.imgUrl ? String(metadata.imgUrl).trim() : null

  const phoneNorm = normalizePhoneBR(phone) || String(phone || '').replace(/\D/g, '').trim()
  const nome = name || short || notify || vname || (phoneNorm || null)
  const foto_perfil = profilePicUrl || (imgUrl || null)

  const result = { nome: nome || null, pushname: notify || null, foto_perfil: foto_perfil || null }
  cache.set(key, { data: result, exp: Date.now() + CACHE_TTL_MS })
  if (cache.size > 500) {
    const now = Date.now()
    for (const [k, v] of cache.entries()) {
      if (v.exp < now) cache.delete(k)
    }
  }
  return result
}

module.exports = { syncContactFromUltramsg }
