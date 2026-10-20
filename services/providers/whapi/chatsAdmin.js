/**
 * Chat admin Whapi — arquivos próprios (não misturar com UltraMSG).
 * Archive: POST /chats/{ChatID} { archive }
 * Read:    PATCH /chats/{ChatID} { mark_unread: false }
 * Patch:   PATCH /chats/{ChatID} { pin | mute_until | mark_unread | ephemeral }
 * Delete:  DELETE /chats/{ChatID}
 * List:    GET /chats · GET /groups · GET /groups/{GroupID}
 *
 * TODAS as ações endereçadas por chat passam por `runOnChatCandidates` — ver o comentário
 * dessa função para o porquê (o 9º dígito).
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId, toWhapiGroupId, chatIdCandidates } = require('./phones')
const { post, patch, del, get } = require('./http')
const { extractArray, isWhapiSuccessBody, notImplemented } = require('./parse')

/**
 * Resultado de uma ação de chat.
 * @typedef {{ok: boolean, chatId?: string, httpStatus?: number, naoExistia?: boolean, error?: string}} ResultadoAcaoChat
 */

/**
 * Executa uma ação de chat tentando os endereços de `chatIdCandidates` EM ORDEM.
 *
 * Bug medido no canal de produção em 20/10 (MCP, só leitura): o chat BR vive na Whapi quase
 * sempre SEM o 9º dígito, enquanto `toWhapiChatId` o INSERE (passa por `preferredBrSendDigits`):
 *
 *   GET /chats/553493120506@s.whatsapp.net  → 200 (o chat real)
 *   GET /chats/5534993120506@s.whatsapp.net → 404 "specified chat not found"
 *
 * Com um endereço só, a ação caía em 404 e não saía do WhatsApp — em silêncio. Isso valia para
 * apagar (corrigido primeiro) e vale igual para arquivar, marcar lido e fixar/silenciar.
 *
 * Política (a mesma que o `deleteChat` estreou): 404 = aquele endereço não existe → tenta o
 * próximo; qualquer OUTRO erro PARA na hora (não insiste numa falha real, não multiplica a
 * chamada); todos 404 = o chat não existe sob nenhuma forma conhecida → `naoExistia: true`,
 * que NÃO é a mesma coisa que "o provedor recusou".
 *
 * @param {string} label nome da operação (só para log)
 * @param {string} phone telefone/JID como está em `conversas.telefone`
 * @param {object} opts { companyId, whatsappInstanceId, … }
 * @param {(cfg: object, chatId: string) => Promise<{ok: boolean, status: number, data: any}>} call
 * @returns {Promise<ResultadoAcaoChat>}
 */
async function runOnChatCandidates(label, phone, opts, call) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const candidatos = chatIdCandidates(phone)
  if (!candidatos.length) return { ok: false, error: 'Chat inválido.' }

  let ultimoStatus = null
  for (const chatId of candidatos) {
    try {
      const { ok, status, data } = await call(cfg, chatId)
      ultimoStatus = status
      if (isWhapiSuccessBody(ok, data)) return { ok: true, chatId, httpStatus: status }
      if (Number(status) === 404) continue
      const error = String(data?.error?.message || data?.error || `HTTP ${status}`)
      console.warn(`❌ Whapi ${label} recusado:`, chatId, `HTTP ${status}`, error.slice(0, 160))
      return { ok: false, chatId, httpStatus: status, error }
    } catch (e) {
      console.warn(`❌ Whapi ${label} falhou:`, chatId, e?.message || e)
      return { ok: false, chatId, error: e?.message || String(e) }
    }
  }
  console.warn(`⚠️ Whapi ${label}: nenhum dos endereços existe no canal`, candidatos.join(' · '))
  return { ok: false, naoExistia: true, httpStatus: ultimoStatus ?? 404 }
}

/** POST /chats/{ChatID} { archive }. @returns {Promise<ResultadoAcaoChat>} */
async function archiveChatByFlag(phone, archive, opts = {}) {
  const label = archive === true ? 'archiveChat' : 'unarchiveChat'
  return runOnChatCandidates(label, phone, opts, (cfg, chatId) => post({
    token: cfg.token,
    endpoint: `/chats/${encodeURIComponent(chatId)}`,
    body: { archive: archive === true },
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    skipSendGuard: true,
  }))
}

/** Arquiva o chat na conta conectada. @returns {Promise<ResultadoAcaoChat>} */
async function archiveChat(phone, opts = {}) {
  return archiveChatByFlag(phone, true, opts)
}

/** Desarquiva o chat na conta conectada. @returns {Promise<ResultadoAcaoChat>} */
async function unarchiveChat(phone, opts = {}) {
  return archiveChatByFlag(phone, false, opts)
}

/** Marca o chat como lido. PATCH { mark_unread: false }. @returns {Promise<ResultadoAcaoChat>} */
async function readChat(phone, opts = {}) {
  return runOnChatCandidates('readChat', phone, opts, (cfg, chatId) => patch({
    token: cfg.token,
    endpoint: `/chats/${encodeURIComponent(chatId)}`,
    body: { mark_unread: false },
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    skipSendGuard: true,
  }))
}

/**
 * Apaga o chat na conta conectada. DELETE /chats/{ChatID}.
 * Tenta os endereços em ordem — ver `runOnChatCandidates`.
 * @returns {Promise<ResultadoAcaoChat>}
 */
async function deleteChat(phone, opts = {}) {
  return runOnChatCandidates('deleteChat', phone, opts, (cfg, chatId) => del({
    token: cfg.token,
    endpoint: `/chats/${encodeURIComponent(chatId)}`,
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    skipSendGuard: true,
  }))
}

/**
 * Whapi não tem equivalente de clearMessages — 501 claro (reconferido em 20/10 contra a lista
 * de endpoints do canal: existe apagar o chat, apagar mensagem e apagar mídia, não existe
 * "limpar as mensagens do chat"). Como não há chamada HTTP, não há endereço a tentar: o 9º
 * dígito não entra aqui. Se um dia a Whapi publicar o endpoint, use `runOnChatCandidates`.
 */
async function clearChatMessages() {
  return notImplemented('clearChatMessages')
}

async function getChats(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await get({ token: cfg.token, endpoint: '/chats' })
    if (!ok) return []
    return extractArray(data, ['chats', 'data', 'list'])
  } catch {
    return []
  }
}

/**
 * Metadados de UM chat específico. GET /chats/{ChatID}.
 * `chat` aceita telefone ou chat id (…@s.whatsapp.net / …@g.us). Retorna { ok, chat } ou { ok:false }.
 */
async function getChat(chat, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const chatId = toWhapiChatId(chat)
  if (!chatId) return { ok: false, error: 'Chat inválido.' }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: `/chats/${encodeURIComponent(chatId)}` })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true, chat: data || null, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler chat (Whapi): ${e?.message || e}` }
  }
}

async function getGroups(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const extraParams = {}
    if (opts.count != null) extraParams.count = String(opts.count)
    if (opts.offset != null) extraParams.offset = String(opts.offset)
    const { ok, data } = await get({ token: cfg.token, endpoint: '/groups', extraParams })
    if (!ok) return []
    return extractArray(data, ['groups', 'data', 'chats', 'list'])
  } catch {
    return []
  }
}

async function getGroup(groupId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !groupId) return null
  const gid = toWhapiGroupId(groupId)
  if (!gid) return null
  try {
    const extraParams = {}
    if (opts.resync === true) extraParams.resync = 'true'
    const { ok, data } = await get({
      token: cfg.token,
      endpoint: `/groups/${encodeURIComponent(gid)}`,
      extraParams,
    })
    if (!ok || !data || typeof data !== 'object') return null
    const group = data.group && typeof data.group === 'object' ? data.group : data
    return group
  } catch {
    return null
  }
}

/**
 * Ajustes de chat no WhatsApp do celular. PATCH /chats/{ChatID}.
 * Campos: pin (bool), mute_until (unix ms; 0 = desmutar), mark_unread (bool),
 * ephemeral ('none'|'day'|'week'|'quarter'). Só envia o que vier em `changes`.
 * @returns {Promise<ResultadoAcaoChat>}
 */
async function patchChat(phone, changes = {}, opts = {}) {
  const body = {}
  if (typeof changes.pin === 'boolean') body.pin = changes.pin
  if (changes.mute_until != null) body.mute_until = Number(changes.mute_until)
  if (typeof changes.mark_unread === 'boolean') body.mark_unread = changes.mark_unread
  if (changes.ephemeral != null && ['none', 'day', 'week', 'quarter'].includes(String(changes.ephemeral))) {
    body.ephemeral = String(changes.ephemeral)
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nenhum campo válido para alterar.' }

  return runOnChatCandidates('patchChat', phone, opts, (cfg, chatId) => patch({
    token: cfg.token,
    endpoint: `/chats/${encodeURIComponent(chatId)}`,
    body,
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    skipSendGuard: true,
  }))
}

/** Fixa/desafixa o chat. Atalho de patchChat({ pin }). @returns {Promise<ResultadoAcaoChat>} */
async function pinChat(phone, pin = true, opts = {}) {
  return patchChat(phone, { pin: pin !== false }, opts)
}

/**
 * Silencia/desmuta o chat. mute=true silencia por ~8h (default) ou opts.muteUntil (unix ms);
 * false desmuta. @returns {Promise<ResultadoAcaoChat>}
 */
async function muteChat(phone, mute = true, opts = {}) {
  const muteUntil = mute === false
    ? 0
    : (opts?.muteUntil != null ? Number(opts.muteUntil) : Date.now() + 8 * 60 * 60 * 1000)
  return patchChat(phone, { mute_until: muteUntil }, opts)
}

module.exports = {
  archiveChat,
  unarchiveChat,
  readChat,
  clearChatMessages,
  deleteChat,
  getChats,
  getChat,
  getGroups,
  getGroup,
  patchChat,
  pinChat,
  muteChat,
}
