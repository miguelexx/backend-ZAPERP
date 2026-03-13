/**
 * Sincronização de contato com UltraMsg: busca nome e foto reais do WhatsApp.
 * Função central: syncUltraMsgContact — valida individual, aplica heurísticas, atualiza conversas e clientes.
 * Cache 5 min por (phone, company) para evitar excesso de chamadas (anti-bloqueio).
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const {
  normalizePhoneBR,
  isGroupChat,
  extractPhoneFromChatId,
  possiblePhonesBR
} = require('../helpers/phoneHelper')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { chooseBestName, isBadName, getDisplayName } = require('../helpers/contactEnrichment')

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

function cacheKey(phone, companyId) {
  const p = String(phone || '').replace(/\D/g, '').slice(-11)
  return `${companyId ?? 0}:${p}`
}

function isValidPhotoUrl(url) {
  return url && typeof url === 'string' && url.trim().startsWith('http')
}

/**
 * Resolve telefone a partir de chatId ou phone.
 * @returns {{ telefone: string, chatId: string }|null}
 */
function resolvePhoneAndChatId(chatIdOrPhone) {
  const s = String(chatIdOrPhone || '').trim()
  if (!s) return null
  if (s.startsWith('lid:')) return null

  if (isGroupChat(s)) return null
  let telefone = ''
  let chatId = ''

  if (s.includes('@c.us')) {
    telefone = extractPhoneFromChatId(s)
    chatId = s
  } else {
    telefone = normalizePhoneBR(s) || s.replace(/\D/g, '')
    if (telefone) {
      const digits = telefone.replace(/\D/g, '')
      chatId = digits ? `${digits}@c.us` : ''
    }
  }

  if (!telefone || telefone.length < 10) return null
  const digits = telefone.replace(/\D/g, '')
  if (digits.startsWith('120')) return null
  if (!digits.startsWith('55') || (digits.length !== 12 && digits.length !== 13)) {
    const norm = normalizePhoneBR(telefone)
    if (!norm) return null
    telefone = norm
  }

  return { telefone, chatId: chatId || `${telefone.replace(/\D/g, '')}@c.us` }
}

/**
 * Sincroniza um contato individual com UltraMsg e atualiza banco.
 * Ignora grupos. Nunca sobrescreve dado melhor por pior.
 * Foto: sempre via GET /contacts/image?chatId=... (webhook NÃO traz profile picture).
 *
 * @param {string} chatIdOrPhone - chatId (5511999999999@c.us, ex. data.from) ou telefone
 * @param {number} companyId
 * @param {object} opts - { skipPersistence, skipCache, chatId } — chatId força uso direto na API
 * @returns {Promise<{ chatId, telefone, nome, pushname, foto_perfil }|null>}
 */
async function syncUltraMsgContact(chatIdOrPhone, companyId, opts = {}) {
  const resolved = resolvePhoneAndChatId(chatIdOrPhone)
  if (!resolved) return null

  const { telefone, chatId } = resolved
  const key = cacheKey(telefone, companyId)

  let result = null
  const useCache = !opts.skipCache
  if (useCache) {
    const cached = cache.get(key)
    if (cached && cached.exp > Date.now()) {
      result = cached.data
      if (opts.skipPersistence) return result
    }
  }

  if (!result) {
    const provider = getProvider()
    if (!provider?.getContactMetadata && !provider?.getProfilePicture) return null

    const { config, error } = await getEmpresaWhatsappConfig(companyId)
    if (error || !config) return null

    let metadata = null
    let profilePicUrl = null
    const picOpts = { companyId, chatId }

    try {
      const [meta, pic] = await Promise.all([
        provider.getContactMetadata?.(telefone, { companyId, chatId }).catch(() => null) ?? null,
        provider.getProfilePicture?.(chatId, picOpts).catch(() => null) ?? null
      ])
      metadata = meta
      profilePicUrl = pic
    } catch (e) {
      console.warn('[syncUltraMsgContact] UltraMsg falhou:', e?.message || 'erro', '| company:', companyId)
      return null
    }

    const name = metadata?.name ? String(metadata.name).trim() : null
    const pushnameApi = metadata?.pushname ?? metadata?.notify
    const pushnameFromApi = pushnameApi ? String(pushnameApi).trim() : null
    const short = metadata?.short ? String(metadata.short).trim() : null
    const vname = metadata?.vname ? String(metadata.vname).trim() : null
    const imgUrl = metadata?.imgUrl ? String(metadata.imgUrl).trim() : null

    const nomeFromApi = name || short || pushnameFromApi || vname || null
    const fotoFromApi = (profilePicUrl && isValidPhotoUrl(profilePicUrl)) || (imgUrl && isValidPhotoUrl(imgUrl))
      ? (profilePicUrl || imgUrl || null)
      : null

    const telefoneFormatado = telefone.replace(/\D/g, '').length >= 10 ? telefone : null

    result = {
      chatId,
      telefone,
      nome: nomeFromApi || telefoneFormatado,
      pushname: pushnameFromApi || null,
      foto_perfil: fotoFromApi || null
    }

    cache.set(key, { data: result, exp: Date.now() + CACHE_TTL_MS })
    if (cache.size > 500) {
      const now = Date.now()
      for (const [k, v] of cache.entries()) {
        if (v.exp < now) cache.delete(k)
      }
    }

    if (opts.skipPersistence) return result
  }

  const variants = possiblePhonesBR(telefone).length > 0 ? possiblePhonesBR(telefone) : [telefone]
  const telefoneTail = String(telefone).replace(/\D/g, '').slice(-6) || null
  const nomeFromResult = result.nome || null
  const pushnameFromResult = result.pushname || null
  const fotoFromResult = result.foto_perfil || null

  try {
    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, nome_contato_cache, foto_perfil_contato_cache, cliente_id')
      .eq('company_id', companyId)
      .in('telefone', variants)

    const convRows = Array.isArray(conversas) ? conversas : []

    for (const conv of convRows) {
      const cacheUpdates = {}
      const nomeCandidato = nomeFromResult || telefone
      if (nomeCandidato && !isBadName(nomeCandidato)) {
        const { name: bestNome, decision } = chooseBestName(
          conv.nome_contato_cache || null,
          String(nomeCandidato).trim(),
          'syncUltramsg',
          { fromMe: false, company_id: companyId, telefoneTail }
        )
        if (bestNome && decision === 'updated') cacheUpdates.nome_contato_cache = bestNome
      }
      const fotoAtual = conv.foto_perfil_contato_cache && String(conv.foto_perfil_contato_cache).trim()
      if (fotoFromResult && isValidPhotoUrl(fotoFromResult) && !fotoAtual) {
        cacheUpdates.foto_perfil_contato_cache = String(fotoFromResult).trim()
      }
      if (Object.keys(cacheUpdates).length > 0) {
        await supabase.from('conversas').update(cacheUpdates).eq('id', conv.id).eq('company_id', companyId)
      }
    }

    await getOrCreateCliente(supabase, companyId, telefone, {
      nome: nomeFromResult || undefined,
      nomeSource: 'syncUltramsg',
      pushname: pushnameFromResult || undefined,
      foto_perfil: fotoFromResult || undefined
    })
  } catch (e) {
    console.warn('[syncUltraMsgContact] Erro ao atualizar banco:', e?.message || e)
  }

  return result
}

/**
 * Wrapper compatível: retorna { nome, pushname, foto_perfil } para uso em getOrCreateCliente.
 * Usado por syncViaFallback e enrichConversationsWithContactData.
 */
async function syncContactFromUltramsg(phone, companyId) {
  const data = await syncUltraMsgContact(phone, companyId, { skipPersistence: true })
  if (!data) return null
  return {
    nome: data.nome || null,
    pushname: data.pushname || null,
    foto_perfil: data.foto_perfil || null
  }
}

/**
 * Sincroniza contato ao abrir conversa (join_conversa ou GET /chats/:id).
 * Consulta API UltraMsg e atualiza nome/foto se necessário; emite contato_atualizado.
 * @param {object} supabase - Cliente Supabase
 * @param {number} conversaId - ID da conversa
 * @param {number} companyId - ID da empresa
 * @param {object} io - Socket.io
 * @param {object} opts - { skipIfRecent } - evita sync se já fez nos últimos 60s (por conversa)
 */
const _lastSyncByConv = new Map()
const SYNC_DEBOUNCE_MS = 60_000

async function syncConversationContactOnJoin(supabase, conversaId, companyId, io, opts = {}) {
  if (!conversaId || !companyId || !io) return
  const key = `${companyId}:${conversaId}`
  if (opts.skipIfRecent && _lastSyncByConv.get(key) && Date.now() - _lastSyncByConv.get(key) < SYNC_DEBOUNCE_MS) {
    return
  }

  try {
    const { data: conv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, nome_contato_cache, foto_perfil_contato_cache')
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!conv || !conv.telefone || conv.telefone.startsWith('lid:') || conv.telefone.includes('@g.us')) return

    const chatId = conv.telefone.includes('@c.us') ? conv.telefone : `${String(conv.telefone).replace(/\D/g, '')}@c.us`
    const synced = await syncUltraMsgContact(chatId, companyId, { skipCache: true })
    if (!synced) return

    _lastSyncByConv.set(key, Date.now())

    const variants = possiblePhonesBR(conv.telefone).length > 0 ? possiblePhonesBR(conv.telefone) : [conv.telefone]
    const { data: cliente } = conv.cliente_id
      ? await supabase.from('clientes').select('id, nome, pushname, telefone, foto_perfil').eq('id', conv.cliente_id).eq('company_id', companyId).maybeSingle()
      : await supabase.from('clientes').select('id, nome, pushname, telefone, foto_perfil').eq('company_id', companyId).in('telefone', variants).limit(1).maybeSingle()

    const upCliente = {}
    const syncNomeValido = synced.nome && String(synced.nome).trim() && !isBadName(synced.nome)
    if (syncNomeValido && (!cliente?.nome || String(cliente.nome).trim() !== String(synced.nome).trim())) {
      upCliente.nome = String(synced.nome).trim()
    }
    if (synced.pushname && (!cliente?.pushname || !String(cliente.pushname).trim())) upCliente.pushname = synced.pushname
    if (synced.foto_perfil && (!cliente?.foto_perfil || !String(cliente.foto_perfil).trim())) upCliente.foto_perfil = synced.foto_perfil
    const clienteIdToUpdate = conv.cliente_id || cliente?.id
    if (Object.keys(upCliente).length > 0 && clienteIdToUpdate) {
      await supabase.from('clientes').update(upCliente).eq('id', clienteIdToUpdate).eq('company_id', companyId)
    }

    const upConv = {}
    if (syncNomeValido && (!conv.nome_contato_cache || !String(conv.nome_contato_cache).trim())) {
      upConv.nome_contato_cache = String(synced.nome).trim()
    }
    if (synced.foto_perfil && (!conv.foto_perfil_contato_cache || !String(conv.foto_perfil_contato_cache).trim())) {
      upConv.foto_perfil_contato_cache = String(synced.foto_perfil).trim()
    }
    if (Object.keys(upConv).length > 0) {
      await supabase.from('conversas').update(upConv).eq('id', conversaId).eq('company_id', companyId)
    }

    const { data: cliAtual } = conv.cliente_id
      ? await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', conv.cliente_id).eq('company_id', companyId).maybeSingle()
      : await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('company_id', companyId).in('telefone', variants).limit(1).maybeSingle()
    const { data: convAtual } = await supabase.from('conversas').select('nome_contato_cache, foto_perfil_contato_cache').eq('id', conversaId).eq('company_id', companyId).maybeSingle()
    const nomeParaEmit = upConv.nome_contato_cache ?? convAtual?.nome_contato_cache ?? getDisplayName(cliAtual) ?? synced.nome ?? null
    const fotoParaEmit = upConv.foto_perfil_contato_cache ?? convAtual?.foto_perfil_contato_cache ?? cliAtual?.foto_perfil ?? synced.foto_perfil ?? null

    if (nomeParaEmit || fotoParaEmit) {
      io.to(`empresa_${companyId}`).emit('contato_atualizado', {
        conversa_id: Number(conversaId),
        contato_nome: nomeParaEmit ? String(nomeParaEmit).trim() : null,
        nome_contato_cache: nomeParaEmit ? String(nomeParaEmit).trim() : null,
        telefone: cliAtual?.telefone ?? conv.telefone,
        foto_perfil: fotoParaEmit ? String(fotoParaEmit).trim() : null,
        foto_perfil_contato_cache: fotoParaEmit ? String(fotoParaEmit).trim() : null
      })
    }
  } catch (e) {
    console.warn('[syncConversationContactOnJoin]', conversaId, e?.message || e)
  }
}

module.exports = { syncUltraMsgContact, syncContactFromUltramsg, syncConversationContactOnJoin }
