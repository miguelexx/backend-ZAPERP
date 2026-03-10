/**
 * Sincronização de contato com Z-API: busca nome e foto reais do WhatsApp.
 * Usado ao receber mensagem e ao criar cliente.
 * Cache 5 min por (phone, company) para evitar excesso de chamadas à Z-API (anti-bloqueio).
 */

const zapiProvider = require('./providers/zapi')
const { getEmpresaZapiConfig } = require('./zapiIntegrationService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min — evita centenas de chamadas quando mesmo contato envia várias msgs
const cache = new Map()

function cacheKey(phone, companyId) {
  const p = String(phone || '').replace(/\D/g, '').slice(-11)
  return `${companyId ?? 0}:${p}`
}

/**
 * Busca na Z-API os dados do contato (metadata + foto) e devolve objeto para salvar em clientes.
 * nome = nome exibido no WhatsApp (pushname/notify ou name); foto_perfil = URL da foto.
 * Usa cache para evitar excesso de chamadas (reduz risco de bloqueio).
 *
 * @param {string} phone - Telefone (será normalizado para só dígitos)
 * @param {number} [companyId] - company_id para multi-tenant (obrigatório em produção)
 * @returns {Promise<{ nome: string|null, pushname: string|null, foto_perfil: string|null }|null>}
 */
async function syncContactFromZapi(phone, companyId) {
  const key = cacheKey(phone, companyId)
  const cached = cache.get(key)
  if (cached && cached.exp > Date.now()) return cached.data

  if (!zapiProvider.getContactMetadata || !zapiProvider.getProfilePicture) return null
  if (companyId != null) {
    const { config } = await getEmpresaZapiConfig(companyId)
    if (!config) return null
  }
  const opts = companyId != null ? { companyId } : {}

  const [metadata, profilePicUrl] = await Promise.all([
    zapiProvider.getContactMetadata(phone, opts).catch(() => null),
    zapiProvider.getProfilePicture(phone, opts).catch(() => null)
  ])

   // Se não conseguimos nenhum dado (nem metadata, nem foto), não altere o banco (evita sobrescrever nomes por falha de rede).
   if (!metadata && !profilePicUrl) return null

  const notify = metadata?.notify ? String(metadata.notify).trim() : null
  const name = metadata?.name ? String(metadata.name).trim() : null
  const short = metadata?.short ? String(metadata.short).trim() : null
  const vname = metadata?.vname ? String(metadata.vname).trim() : null
  const imgUrl = metadata?.imgUrl ? String(metadata.imgUrl).trim() : null

  // Prioridade: name (nome completo salvo no celular) > short (primeiro nome) > notify (perfil WA) > vname
  const phoneNorm = normalizePhoneBR(phone) || String(phone || '').replace(/\D/g, '').trim()
  const nome = name || short || notify || vname || (phoneNorm || null)
  const foto_perfil = profilePicUrl || (imgUrl || null)

  const result = {
    nome: nome || null,
    pushname: notify || null,
    foto_perfil: foto_perfil || null
  }

  cache.set(key, { data: result, exp: Date.now() + CACHE_TTL_MS })
  if (cache.size > 500) {
    const now = Date.now()
    for (const [k, v] of cache.entries()) {
      if (v.exp < now) cache.delete(k)
    }
  }

  return result
}

module.exports = { syncContactFromZapi }
