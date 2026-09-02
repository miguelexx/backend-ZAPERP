const { isSameWhatsappIdentity } = require('../../../helpers/phoneHelper')
const { WHATSAPP_DEBUG, CONTACTS_API_CHUNK_MAX } = require('./constants')
const { profilePictureChatIdCandidates, contactRecordMatchesChatId } = require('./phones')
const { resolveConfig } = require('./config')
const { getJson } = require('./http')

const { agendaContactFields } = require('../../../helpers/agendaContact')

function parseContactsResponse(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return null
  for (const key of ['contacts', 'data', 'list', 'contact']) {
    if (Array.isArray(data[key])) return data[key]
    if (data[key] && typeof data[key] === 'object') {
      const nested = parseContactsResponse(data[key])
      if (nested) return nested
    }
  }
  return null
}

// GET /contacts é uma lista completa: a documentação não oferece limit/offset.
// A paginação é feita no banco, depois da leitura integral da agenda.
async function getContacts(page = 1, pageSize = CONTACTS_API_CHUNK_MAX, opts = {}) {
  if (Number(page) > 1) return { data: [], hasMore: false, rawCount: 0 }
  const cfg = await resolveConfig(opts)
  if (!cfg) throw new Error('Instância WhatsApp não configurada para esta empresa.')
  let response
  try {
    response = await getJson({ ...cfg, endpoint: '/contacts' })
  } catch {
    throw new Error('Não foi possível consultar a agenda na UltraMSG. Verifique a conexão e tente novamente.')
  }
  const { ok, status, data } = response
  if (!ok || data?.error || data?.success === false) {
    throw new Error('A UltraMSG recusou a consulta de contatos' + (status ? ' (HTTP ' + status + ')' : '') + '. Verifique a conexão e as credenciais da instância.')
  }
  const raw = parseContactsResponse(data)
  if (!raw) throw new Error('A UltraMSG retornou um formato de agenda inválido. Tente novamente.')
  const contacts = raw.map(agendaContactFields).filter(Boolean)
  return { data: contacts, hasMore: false, rawCount: raw.length }
}

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
