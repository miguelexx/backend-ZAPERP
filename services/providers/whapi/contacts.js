/**
 * Contatos e foto de perfil Whapi — arquivos próprios (não misturar com UltraMSG).
 * GET /contacts (count/offset) · GET /contacts/{ContactID} · GET /contacts/{ContactID}/profile
 * Contrato getContacts: { data, hasMore, rawCount } — o sync da agenda espera isso.
 */

const { agendaContactFields } = require('../../../helpers/agendaContact')
const { resolveConfig } = require('./config')
const { toWhapiContactId, isGroupJid } = require('./phones')
const { get } = require('./http')
const { extractArray, firstHttpUrl } = require('./parse')

const CONTACTS_PAGE_MAX = 500

function mapWhapiContactForAgenda(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id != null ? String(raw.id).trim() : ''
  return {
    ...raw,
    id,
    phone: id || raw.phone || raw.number || '',
    name: raw.name || raw.pushname || raw.formattedName || null,
    pushname: raw.pushname || raw.pushName || null,
    imgUrl: firstHttpUrl(raw.profile_pic_full, raw.profile_pic, raw.icon_full, raw.icon, raw.imgUrl),
    isMyContact: raw.saved !== false && raw.isMyContact !== false,
    isGroup: isGroupJid(id) || raw.type === 'group',
  }
}

async function getContacts(page = 1, pageSize = 100, opts = {}) {
  if (page && typeof page === 'object') {
    opts = page
    page = 1
    pageSize = 100
  }
  const pageNum = Math.max(1, Number(page) || 1)
  const size = Math.min(CONTACTS_PAGE_MAX, Math.max(1, Number(pageSize) || 100))
  const cfg = await resolveConfig(opts)
  if (!cfg) throw new Error('Instância Whapi não configurada para esta empresa.')
  const offset = (pageNum - 1) * size
  let response
  try {
    response = await get({
      token: cfg.token,
      endpoint: '/contacts',
      extraParams: { count: String(size), offset: String(offset) },
    })
  } catch {
    throw new Error('Não foi possível consultar a agenda na Whapi. Verifique a conexão e tente novamente.')
  }
  const { ok, status, data } = response
  if (!ok || data?.error || data?.success === false) {
    throw new Error('A Whapi recusou a consulta de contatos' + (status ? ' (HTTP ' + status + ')' : '') + '. Verifique a conexão e as credenciais da instância.')
  }
  const raw = extractArray(data, ['contacts', 'data', 'list'])
  const contacts = raw.map(mapWhapiContactForAgenda).map(agendaContactFields).filter(Boolean)
  const iteratorTotal = Number(data?.total)
  const hasMore = Number.isFinite(iteratorTotal)
    ? (offset + raw.length) < iteratorTotal
    : raw.length >= size
  return { data: contacts, hasMore, rawCount: raw.length }
}

function buildContactMetadataResult(data) {
  if (!data || typeof data !== 'object') return null
  const name = data.name ?? data.formattedName ?? null
  const pushname = data.pushname ?? data.pushName ?? data.notify ?? null
  const imgRaw = firstHttpUrl(
    data.icon_full, data.icon, data.profile_pic_full, data.profile_pic, data.imgUrl, data.photo
  )
  return {
    name: name ? String(name).trim() : null,
    pushname: pushname ? String(pushname).trim() : null,
    short: data.short ? String(data.short).trim() : null,
    notify: pushname ? String(pushname).trim() : null,
    vname: data.vname ? String(data.vname).trim() : null,
    imgUrl: imgRaw,
  }
}

async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return null
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}`,
    })
    if (!ok || !data) return null
    const contact = data.contact && typeof data.contact === 'object' ? data.contact : data
    return buildContactMetadataResult(contact)
  } catch {
    return null
  }
}

async function getProfilePicture(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || phone == null) return null
  const raw = String(phone).trim()
  if (!raw) return null
  try {
    if (isGroupJid(raw)) {
      const { ok, data } = await get({
        token: cfg.token,
        endpoint: `/groups/${encodeURIComponent(raw)}`,
      })
      if (!ok || !data) return null
      const group = data.group && typeof data.group === 'object' ? data.group : data
      return firstHttpUrl(group.chat_pic_full, group.chat_pic, group.icon, group.picture, group.image)
    }
    const contactId = toWhapiContactId(raw)
    if (!contactId) return null
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}/profile`,
    })
    if (!ok || !data) return null
    return firstHttpUrl(data.icon_full, data.icon, data.profile_pic_full, data.profile_pic)
  } catch {
    return null
  }
}

function invalidateNoProfilePictureCache() {
  return false
}

module.exports = {
  getContacts,
  getContactMetadata,
  getProfilePicture,
  invalidateNoProfilePictureCache,
}
