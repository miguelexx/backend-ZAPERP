/**
 * Contatos e foto de perfil Whapi — arquivos próprios (não misturar com UltraMSG).
 * GET /contacts (count/offset) · GET /contacts/{ContactID} · GET /contacts/{ContactID}/profile
 * Contrato getContacts: { data, hasMore, rawCount } — o sync da agenda espera isso.
 */

const { agendaContactFields } = require('../../../helpers/agendaContact')
const { resolveConfig } = require('./config')
const { toWhapiContactId, isGroupJid } = require('./phones')
const { get, post, put } = require('./http')
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

/**
 * Verifica quais números têm conta no WhatsApp. POST /contacts { contacts, force_check }.
 * NÃO envia mensagem → skipSendGuard. Útil antes de disparo (evita enviar a número inexistente).
 * Retorna [{ input, exists, waId, status }] preservando a ordem/tamanho do provedor.
 */
async function checkPhones(phones, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) throw new Error('Instância Whapi não configurada para esta empresa.')
  const list = (Array.isArray(phones) ? phones : [phones])
    .map((p) => String(p ?? '').replace(/@[^@]+$/, '').replace(/\D/g, ''))
    .filter(Boolean)
  if (!list.length) return []
  let response
  try {
    response = await post({
      token: cfg.token,
      endpoint: '/contacts',
      body: { contacts: list, ...(opts?.forceCheck === true ? { force_check: true } : {}) },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
  } catch (e) {
    throw new Error(`Não foi possível verificar números na Whapi: ${e?.message || e}`)
  }
  const { ok, status, data } = response
  if (!ok || data?.error) {
    throw new Error('A Whapi recusou a verificação de números' + (status ? ' (HTTP ' + status + ')' : '') + '.')
  }
  const raw = extractArray(data, ['contacts', 'data', 'list'])
  return raw.map((c) => {
    if (!c || typeof c !== 'object') return { input: '', exists: false, waId: null, status: null }
    const input = c.input != null ? String(c.input) : ''
    const statusStr = String(c.status ?? '').toLowerCase()
    const waId = c.wa_id != null ? String(c.wa_id) : (c.waId != null ? String(c.waId) : null)
    const exists = statusStr === 'valid' || (!statusStr && !!waId)
    return { input, exists, waId: exists ? waId : null, status: statusStr || null }
  })
}

/**
 * Recado ("Recado"/about) do contato. GET /contacts/{ContactID}/about → { about }.
 * Retorna string ou null. Grupo não tem about → null.
 */
async function getContactAbout(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return null
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}/about`,
    })
    if (!ok || !data) return null
    const about = data.about ?? data.status ?? null
    return about != null ? String(about) : null
  } catch {
    return null
  }
}

/**
 * Adiciona/atualiza um contato na agenda do WhatsApp. PUT /contacts { phone, name }.
 * Retorna { ok, contact?, error }.
 */
async function addContact(phone, name, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  const nome = String(name || '').trim()
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido' }
  if (!nome) return { ok: false, error: 'Nome obrigatório' }
  try {
    const { ok, status, data } = await put({
      token: cfg.token,
      endpoint: '/contacts',
      body: { phone: contactId, name: nome },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    const contact = data?.contact && typeof data.contact === 'object' ? data.contact : data
    return { ok: true, contact }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao adicionar contato (Whapi): ${e?.message || e}` }
  }
}

/**
 * Resolve LID (@lid) → ContactID real. GET /contacts/ids/{ContactLID} → { id }.
 * Útil em conversas lid (editar/apagar precisam do id real). Retorna string ou null.
 */
async function getIdByLid(lid, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const raw = String(lid || '').trim()
  if (!raw) return null
  const lidId = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@lid`
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/ids/${encodeURIComponent(lidId)}`,
    })
    if (!ok || !data) return null
    return data.id != null ? String(data.id) : null
  } catch {
    return null
  }
}

/**
 * Resolve ContactID → LID (@lid). GET /contacts/lids/{ContactID} → { lid }.
 * Retorna string ou null.
 */
async function getLidById(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const contactId = toWhapiContactId(phone)
  if (!contactId) return null
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/lids/${encodeURIComponent(contactId)}`,
    })
    if (!ok || !data) return null
    return data.lid != null ? String(data.lid) : null
  } catch {
    return null
  }
}

module.exports = {
  getContacts,
  getContactMetadata,
  getProfilePicture,
  invalidateNoProfilePictureCache,
  checkPhones,
  getContactAbout,
  addContact,
  getIdByLid,
  getLidById,
}
