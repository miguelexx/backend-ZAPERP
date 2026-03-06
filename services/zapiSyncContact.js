/**
 * Sincronização de contato com Z-API: busca nome e foto reais do WhatsApp.
 * Usado ao receber mensagem e ao criar cliente.
 * Sempre usa provider Z-API quando companyId tem empresa_zapi.
 */

const zapiProvider = require('./providers/zapi')
const { getEmpresaZapiConfig } = require('./zapiIntegrationService')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

/**
 * Busca na Z-API os dados do contato (metadata + foto) e devolve objeto para salvar em clientes.
 * nome = nome exibido no WhatsApp (pushname/notify ou name); foto_perfil = URL da foto.
 *
 * @param {string} phone - Telefone (será normalizado para só dígitos)
 * @param {number} [companyId] - company_id para multi-tenant (obrigatório em produção)
 * @returns {Promise<{ nome: string|null, pushname: string|null, foto_perfil: string|null }|null>}
 */
async function syncContactFromZapi(phone, companyId) {
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

  return {
    nome: nome || null,
    pushname: notify || null,
    foto_perfil: foto_perfil || null
  }
}

module.exports = { syncContactFromZapi }
