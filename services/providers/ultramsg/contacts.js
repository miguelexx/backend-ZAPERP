const { isSameWhatsappIdentity } = require('../../../helpers/phoneHelper')
const { WHATSAPP_DEBUG, CONTACTS_API_CHUNK_MAX } = require('./constants')
const { profilePictureChatIdCandidates, contactRecordMatchesChatId } = require('./phones')
const { resolveConfig } = require('./config')
const { getJson } = require('./http')

/**
 * Extrai array de contatos da resposta UltraMsg (suporta múltiplos formatos).
 */
function parseContactsResponse(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.contacts)) return data.contacts
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.contact)) return data.contact
  return []
}

/**
 * Chunk alto para pedir toda a agenda em uma única chamada.
 * A UltraMsg retorna a lista inteira da instância de uma só vez (sem paginação real).
 * Usar um valor grande garante que o limit da API nunca corte a lista.
 */

/**
 * Lista contatos salvos na agenda do celular conectado via QR.
 * UltraMsg: GET /{instance_id}/contacts — retorna APENAS da instância conectada.
 *
 * Estratégia: página 1 sem parâmetros (API retorna tudo de uma vez).
 * Páginas seguintes com limit+offset caso a API suporte e o chunk anterior tenha chegado ao limite.
 *
 * @returns {{ data: object[], hasMore: boolean, rawCount: number }}
 */
async function getContacts(page = 1, pageSize = CONTACTS_API_CHUNK_MAX, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { data: [], hasMore: false, rawCount: 0 }
  }
  const limit = Math.min(CONTACTS_API_CHUNK_MAX, Math.max(100, Number(pageSize) || CONTACTS_API_CHUNK_MAX))
  const offset = (Math.max(1, Number(page)) - 1) * limit

  const tryFetch = async (extraParams) => {
    const { ok, data } = await getJson({
      ...cfg,
      endpoint: '/contacts',
      extraParams: { ...extraParams }
    })
    if (!ok) return []
    return parseContactsResponse(data)
  }

  try {
    // Sempre envia limit para garantir que o UltraMsg não aplique um teto padrão interno.
    // Offset 0 na página 1; offset calculado nas páginas seguintes (caso a API pagine).
    let raw
    if (page === 1) {
      raw = await tryFetch({ limit: String(limit), offset: '0' })
      // Alguns servidores UltraMsg ignoram params e devolvem tudo; outros respeitam o limit.
      // Se recebemos 0, tenta sem params como último recurso.
      if (raw.length === 0) {
        raw = await tryFetch({})
      }
    } else {
      raw = await tryFetch({ limit: String(limit), offset: String(offset) })
    }

    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getContacts', { page, limit, offset, rawTotal: raw.length })
    }

    const contacts = []
    for (const c of raw) {
      const phoneRaw = String(c.id || c.phone || c.wa_id || '').trim()
      // Ignorar grupos, broadcasts e IDs inválidos
      if (!phoneRaw || phoneRaw.endsWith('@g.us') || phoneRaw.endsWith('@broadcast')) continue
      // Exigir name: apenas contatos salvos na agenda têm este campo preenchido
      if (!c.name || !String(c.name).trim()) continue

      const digits = phoneRaw.replace(/\D/g, '')
      if (!digits || digits.length < 10) continue

      contacts.push({
        phone: phoneRaw,
        name: String(c.name).trim(),
        short: c.short ? String(c.short).trim() : null,
        notify: c.notify ? String(c.notify).trim() : null,
        vname: c.vname ? String(c.vname).trim() : null,
        imgUrl: c.imgUrl || c.photo || null
      })
    }

    if (WHATSAPP_DEBUG) {
      console.log('[ULTRAMSG] getContacts filtrado:', { total_api: raw.length, com_name: contacts.length })
    }
    // hasMore se a API devolveu exatamente `limit` itens (pode haver mais na próxima página)
    const hasMore = raw.length > 0 && raw.length >= limit
    return { data: contacts, hasMore, rawCount: raw.length }
  } catch (e) {
    if (WHATSAPP_DEBUG) console.warn('[ULTRAMSG] getContacts erro:', e?.message)
    return { data: [], hasMore: false, rawCount: 0 }
  }
}

/**

function extractContactFromResponse(rawData) {
  if (!rawData || typeof rawData !== 'object') return null
  const candidates = [rawData.contact, rawData.data, rawData]
  for (const c of candidates) {
    if (c && typeof c === 'object' && (c.name != null || c.pushname != null || c.pushName != null || c.notify != null)) {
      return c
    }
  }
  if (rawData.name != null || rawData.pushname != null || rawData.pushName != null || rawData.notify != null) {
    return rawData
  }
  return null
}

/**
 * Metadados do contato. UltraMsg: GET /contacts/contact?chatId=... ou busca em GET /contacts.
 * Retorna: { name, short, notify, vname, imgUrl } para ultramsgSyncContact.
 * Prioridade: name (nome salvo no celular) > pushname (nome de perfil WhatsApp).
 * imgUrl só é usado se o contato retornado bater com o chatId pedido.
 */
function buildContactMetadataResult(data, { includeImgUrl = true } = {}) {
  if (!data) return null
  const name = data.name ?? data.formattedName ?? null
  const pushname = data.pushname ?? data.pushName ?? data.notify ?? null
  const imgRaw = includeImgUrl ? (data.imgUrl ?? data.photo ?? data.profilePicture ?? null) : null
  return {
    name: name ? String(name).trim() : null,
    pushname: pushname ? String(pushname).trim() : null,
    short: data.short ? String(data.short).trim() : null,
    notify: pushname ? String(pushname).trim() : null,
    vname: data.vname ? String(data.vname).trim() : null,
    imgUrl: imgRaw && String(imgRaw).trim().startsWith('http') ? String(imgRaw).trim() : null
  }
}

async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const candidates = profilePictureChatIdCandidates(phone, opts)
  const chatId = candidates[0]
  if (!chatId) return null
  const paramNames = ['chatId', 'chatID']
  for (const paramName of paramNames) {
    try {
      const { ok, data: rawData } = await getJson({
        ...cfg,
        endpoint: '/contacts/contact',
        extraParams: { [paramName]: chatId }
      })
      if (WHATSAPP_DEBUG) {
        console.log('[ULTRAMSG] getContactMetadata', { chatId: chatId.slice(-12), paramName, ok, hasData: !!rawData, keys: rawData && typeof rawData === 'object' ? Object.keys(rawData) : [] })
      }
      const data = extractContactFromResponse(rawData)
      if (ok && data) {
        const identity = contactRecordMatchesChatId(data, chatId)
        if (identity.hasIdentity && !identity.matched) {
          if (WHATSAPP_DEBUG) {
            console.warn('[ULTRAMSG] getContactMetadata ignorado: contato retornado não bate com o chatId pedido')
          }
          continue
        }
        const result = buildContactMetadataResult(data, { includeImgUrl: identity.matched || !identity.hasIdentity })
        if (!identity.matched) result.imgUrl = null
        if (WHATSAPP_DEBUG && (result.name || result.pushname)) {
          console.log('[ULTRAMSG] getContactMetadata resultado:', { name: result.name || '(vazio)', pushname: result.pushname || '(vazio)' })
        }
        return result
      }
    } catch (e) {
      if (WHATSAPP_DEBUG) console.warn('[ULTRAMSG] getContactMetadata erro:', paramName, e?.message)
    }
  }
  try {
    const digits = String(phone || '').replace(/\D/g, '')
    for (let page = 1; page <= 3; page++) {
      const { ok: okList, data: listData } = await getJson({
        ...cfg,
        endpoint: '/contacts',
        extraParams: { limit: '100', offset: String((page - 1) * 100) }
      })
      if (!okList) break
      const arr = Array.isArray(listData) ? listData : (listData?.contacts || [])
      const found = arr.find((c) => {
        const cPhone = String(c.id ?? c.phone ?? c.wa_id ?? '').replace(/\D/g, '')
        if (!cPhone) return false
        return isSameWhatsappIdentity(cPhone, digits)
      })
      if (found) {
        return buildContactMetadataResult(found)
      }
      if (arr.length < 100) break
    }
    return null
  } catch {
    return null
  }
}

module.exports = {
  getContacts,
  getContactMetadata,
}
