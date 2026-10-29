/**
 * Contatos e foto de perfil Whapi — arquivos próprios (não misturar com UltraMSG).
 * GET /contacts · GET/HEAD/PATCH/DELETE /contacts/{ContactID} · PUT /contacts · POST /contacts (check)
 * GET /contacts/{id}/profile · /about · LID: /contacts/lids e /contacts/ids/{lid}
 * Contrato getContacts: { data, hasMore, rawCount } — o sync da agenda espera isso.
 */

const { agendaContactFields } = require('../../../helpers/agendaContact')
const { isBadName } = require('../../../helpers/contactEnrichment')
const { phoneKeyBR } = require('../../../helpers/phoneHelper')
const { getChatBookName } = require('./chatsAdmin')
const { resolveConfig } = require('./config')
const { toWhapiContactId, isGroupJid } = require('./phones')
const { get, post, put, patch, del, head } = require('./http')
const { extractArray, firstHttpUrl } = require('./parse')

const CONTACTS_PAGE_MAX = 500
const CHATS_PAGE_MAX = 500
const CHATS_INDEX_MAX_PAGES = 40
const CHAT_NAME_CONCURRENCY = 3

/**
 * Nome SALVO NA AGENDA que a lista `/contacts` traz. `pushname`/`notify` são o perfil do
 * CLIENTE (ele escolhe; "❤", "Rayssa"), nunca o nome salvo no celular — não entram aqui.
 * Quem ficar sem nome segue para `getAgendaNamesFromChats` (o nome pode viver em `/chats/{id}`).
 */
function firstWhapiContactName(raw) {
  return [raw.name, raw.formattedName].find((v) => typeof v === 'string' && v.trim())
}

/** Telefone individual (só dígitos) de um item de `/contacts`; null para grupo, LID, broadcast ou id inválido. */
function whapiContactPhoneId(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id != null ? String(raw.id).trim() : ''
  if (!id || isGroupJid(id) || raw.type === 'group') return null
  if (/lid|broadcast|newsletter|@g\.us/i.test(id)) return null
  if (id.includes('@') && !/^\d{10,15}@(c\.us|s\.whatsapp\.net)$/.test(id)) return null
  const digits = id.replace(/@.*$/, '').replace(/\D/g, '')
  return /^\d{10,15}$/.test(digits) ? digits : null
}

function mapWhapiContactForAgenda(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id != null ? String(raw.id).trim() : ''
  if (!id) return null
  if (isGroupJid(id) || raw.type === 'group') return null
  const name = firstWhapiContactName(raw)
  if (!name) return null
  return {
    ...raw,
    id,
    phone: id || raw.phone || raw.number || '',
    name: String(name).trim(),
    pushname: raw.pushname || raw.pushName || null,
    imgUrl: firstHttpUrl(raw.profile_pic_full, raw.profile_pic, raw.icon_full, raw.icon, raw.imgUrl),
    // GET /contacts mistura agenda salva (saved/phonebook) e chats com só pushname.
    // Exigir saved=true esvaziava a importação. Nome (salvo ou pushname) + telefone bastam.
    isMyContact: true,
    isGroup: false,
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
  const contacts = raw.map(mapWhapiContactForAgenda).filter(Boolean).map(agendaContactFields).filter(Boolean)
  // Medido no canal em 29/10 (1547 itens): 670 vêm SEM nome e 10 com o telefone formatado no
  // lugar do nome ("+55 34 3423-8595"), e uma parte deles está salva na agenda — a lista diz
  // `saved:false` e só `GET /chats/{id}` traz o nome. Devolvemos esses ids em `semNome` para a
  // sincronização completar pelo chat, em vez de descartá-los em silêncio.
  const semNome = []
  for (const item of raw) {
    const name = item && typeof item === 'object' ? firstWhapiContactName(item) : null
    if (name && !isBadName(name)) continue
    const digits = whapiContactPhoneId(item)
    if (digits) semNome.push(digits)
  }
  const iteratorTotal = Number(data?.total)
  const hasMore = Number.isFinite(iteratorTotal)
    ? (offset + raw.length) < iteratorTotal
    : raw.length >= size
  return { data: contacts, hasMore, rawCount: raw.length, total: Number.isFinite(iteratorTotal) ? iteratorTotal : null, semNome }
}

/**
 * Índice dos chats individuais do canal (chave = identidade do celular, ±9º dígito).
 * Lê `GET /chats` paginado (a lista NÃO traz `name`; serve só para saber quem tem conversa).
 * Devolve null quando a lista não pôde ser lida — quem chama consulta todos os ids, sem filtro.
 */
async function loadIndividualChatIndex(cfg) {
  const keys = new Set()
  let offset = 0
  for (let page = 0; page < CHATS_INDEX_MAX_PAGES; page++) {
    let response
    try {
      response = await get({
        token: cfg.token,
        endpoint: '/chats',
        extraParams: { count: String(CHATS_PAGE_MAX), offset: String(offset) },
      })
    } catch {
      return null
    }
    const { ok, data } = response
    if (!ok || data?.error) return null
    const rows = extractArray(data, ['chats', 'data', 'list'])
    for (const chat of rows) {
      const id = chat && chat.id != null ? String(chat.id) : ''
      if (!/@(s\.whatsapp\.net|c\.us)$/.test(id)) continue
      const key = phoneKeyBR(id.replace(/@.*$/, ''))
      if (key) keys.add(key)
    }
    offset += rows.length
    const total = Number(data?.total)
    const more = Number.isFinite(total) ? offset < total : rows.length >= CHATS_PAGE_MAX
    if (!rows.length || !more) break
  }
  return keys
}

/**
 * Nome da agenda para contatos que `GET /contacts` devolveu sem nome utilizável.
 *
 * Por que existe: o nome salvo no celular vive em `GET /chats/{id}.name` (ver
 * `getContactMetadata`), e a lista `/contacts` omite esse nome para parte dos contatos salvos.
 * Custo controlado: lê a lista de chats uma vez (1–2 chamadas) e só consulta `GET /chats/{id}`
 * de quem tem conversa no canal — sem chat não há de onde tirar nome. O endereço do chat tolera
 * o 9º dígito (`getChatBookName` → `runOnChatCandidates`).
 *
 * @param {string[]} ids telefones (dígitos) vindos de `getContacts().semNome`
 * @param {object} opts { companyId, whatsappInstanceId }
 * @param {object} [hooks] { shouldStop: async () => boolean, onProgress: async ({ verificados, total, encontrados }) => void }
 * @returns {Promise<{ names: Map<string,string>, total: number, verificados: number, encontrados: number, semChat: number, chatSemNome: number, cancelado: boolean }>}
 */
async function getAgendaNamesFromChats(ids, opts = {}, hooks = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) throw new Error('Instância Whapi não configurada para esta empresa.')
  const unique = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((v) => String(v || '').replace(/@.*$/, '').replace(/\D/g, ''))
      .filter((d) => /^\d{10,15}$/.test(d))
  )]
  const result = { names: new Map(), total: unique.length, verificados: 0, encontrados: 0, semChat: 0, chatSemNome: 0, cancelado: false }
  if (!unique.length) return result

  const index = await loadIndividualChatIndex(cfg)
  const fila = unique.filter((id) => {
    if (index && !index.has(phoneKeyBR(id))) {
      result.semChat++
      return false
    }
    return true
  })
  result.verificados = result.semChat

  const stop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : null
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null
  let desdeUltimoStop = 0
  for (let i = 0; i < fila.length; i += CHAT_NAME_CONCURRENCY) {
    if (stop && (desdeUltimoStop === 0 || desdeUltimoStop >= 10)) {
      desdeUltimoStop = 0
      if (await stop()) {
        result.cancelado = true
        break
      }
    }
    const chunk = fila.slice(i, i + CHAT_NAME_CONCURRENCY)
    const nomes = await Promise.all(chunk.map(async (id) => {
      try {
        return await getChatBookName(id, opts)
      } catch {
        return null
      }
    }))
    chunk.forEach((id, k) => {
      const nome = nomes[k]
      if (nome && !isBadName(nome)) {
        result.names.set(id, String(nome).trim())
        result.encontrados++
      } else {
        result.chatSemNome++
      }
    })
    result.verificados += chunk.length
    desdeUltimoStop += chunk.length
    if (onProgress) {
      await onProgress({ verificados: result.verificados, total: result.total, encontrados: result.encontrados })
    }
  }
  return result
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

const EMPTY_CONTACT_METADATA = {
  name: null, pushname: null, short: null, notify: null, vname: null, imgUrl: null,
}

/**
 * Nome/pushname/foto de UM contato. Esta é a ÚNICA porta pela qual o nome do WhatsApp entra em
 * `clientes.nome` e `conversas.nome_contato_cache` (via `syncUltraMsgContact`) — webhook de
 * mensagem, enriquecimento da lista de conversas, cadastro manual e varredura de fotos todos
 * passam por aqui.
 *
 * `GET /contacts/{id}` NÃO basta. Medido no canal de produção em 21/10 (MCP, só leitura): para
 * um contato que o atendente tem salvo na agenda o endpoint responde sem nome —
 * `{"phonebook":false,"saved":false,"id":"553497829258"}` — enquanto `GET /chats/{id}` traz
 * `"name":"Claudia DB"`. Sem esse segundo passo o atendimento ficava com o pushname do cliente
 * ("❤") e, como `isBadName` recusa pushname desse tipo, a lista caía no telefone cru: o
 * atendente não achava o cliente pelo nome. Por isso, quando `/contacts` não devolve nome
 * utilizável, o nome vem do chat (`getChatBookName`).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipChatNameFallback] não consultar `/chats` (chamadas em leque, como
 *   enriquecer participantes de grupo, onde o 1:1 quase nunca existe e o custo multiplica)
 */
async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return null
  let result = null
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}`,
    })
    if (ok && data) {
      const contact = data.contact && typeof data.contact === 'object' ? data.contact : data
      result = buildContactMetadataResult(contact)
    }
  } catch {
    result = null
  }
  // Nome da agenda do celular conectado. `isBadName` cobre os dois jeitos de `/contacts` não
  // responder nome: ausente, ou o próprio telefone formatado ("+55 34 3423-8595", visto no canal).
  if (opts.skipChatNameFallback !== true && isBadName(result?.name)) {
    let chatName = null
    try {
      chatName = await getChatBookName(phone, opts)
    } catch {
      chatName = null
    }
    if (chatName && !isBadName(chatName)) {
      return { ...(result || EMPTY_CONTACT_METADATA), name: chatName }
    }
  }
  return result
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

/**
 * GET /contacts/{ContactID}/profile — Get profile (doc Users/Contacts).
 * Devolve o objeto (about, icon, icon_full), não só a URL.
 */
async function getContactProfile(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido' }
  try {
    const { ok, status, data } = await get({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}/profile`,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true, profile: data, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler perfil do contato (Whapi): ${e?.message || e}` }
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

/**
 * HEAD /contacts/{ContactID} — o número tem WhatsApp? 200 sim, 404 não.
 * Não envia mensagem. Retorna { exists, httpStatus }.
 */
async function checkExist(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { exists: false, httpStatus: 0, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return { exists: false, httpStatus: 0, error: 'Número inválido' }
  try {
    const { ok, status } = await head({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}`,
    })
    return { exists: !!ok && status === 200, httpStatus: status }
  } catch (e) {
    return { exists: false, httpStatus: 0, error: e?.message || String(e) }
  }
}

/**
 * PATCH /contacts/{ContactID} { name } — edita o nome na agenda do WhatsApp.
 */
async function editContact(phone, name, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  const nome = String(name || '').trim()
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido' }
  if (!nome) return { ok: false, error: 'Nome obrigatório' }
  try {
    const { ok, status, data } = await patch({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}`,
      body: { name: nome },
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
    return { ok: false, error: `Falha de conexão ao editar contato (Whapi): ${e?.message || e}` }
  }
}

/**
 * DELETE /contacts/{ContactID} — remove da agenda do WhatsApp (não apaga o cliente no ZapERP).
 */
async function deleteContact(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido' }
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: `/contacts/${encodeURIComponent(contactId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao excluir contato (Whapi): ${e?.message || e}` }
  }
}

/**
 * GET /contacts/lids?ContactIDList=a,b — LIDs em lote.
 * Retorna mapa { [contactId]: lid } (vazio em erro).
 */
async function getLidByIds(phones, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return {}
  const ids = (Array.isArray(phones) ? phones : [phones])
    .map((p) => toWhapiContactId(p))
    .filter(Boolean)
  if (!ids.length) return {}
  try {
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: '/contacts/lids',
      extraParams: { ContactIDList: ids.join(',') },
    })
    if (!ok || data == null) return {}
    const out = {}
    const rows = Array.isArray(data)
      ? data
      : (Array.isArray(data.lids) ? data.lids : Array.isArray(data.data) ? data.data : null)
    if (rows) {
      for (const item of rows) {
        if (!item || typeof item !== 'object') continue
        const key = item.id ?? item.phone ?? item.contact_id
        const lid = item.lid
        if (key != null && lid != null) out[String(key)] = String(lid)
      }
      return out
    }
    const source = (data.lids && typeof data.lids === 'object') ? data.lids : data
    for (const [key, value] of Object.entries(source)) {
      if (key === 'error' || key === 'success') continue
      const lid = value && typeof value === 'object' ? value.lid : value
      if (lid != null) out[key] = String(lid)
    }
    return out
  } catch {
    return {}
  }
}

module.exports = {
  getContacts,
  getAgendaNamesFromChats,
  getContactMetadata,
  getProfilePicture,
  getContactProfile,
  invalidateNoProfilePictureCache,
  checkPhones,
  getContactAbout,
  addContact,
  getIdByLid,
  getLidById,
  checkExist,
  editContact,
  deleteContact,
  getLidByIds,
}
