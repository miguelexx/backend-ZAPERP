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
const { toWhapiGroupId, chatIdCandidates } = require('./phones')
const { post, patch, del, get } = require('./http')
const { extractArray, isWhapiSuccessBody, notImplemented } = require('./parse')

/**
 * Resultado de uma ação de chat.
 * @typedef {{ok: boolean, chatId?: string, httpStatus?: number, naoExistia?: boolean, error?: string, data?: any}} ResultadoAcaoChat
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
      if (isWhapiSuccessBody(ok, data)) return { ok: true, chatId, httpStatus: status, data }
      if (Number(status) === 404) continue
      const error = String(data?.error?.message || data?.error || `HTTP ${status}`)
      console.warn(`❌ Whapi ${label} recusado:`, chatId, `HTTP ${status}`, error.slice(0, 160))
      return { ok: false, chatId, httpStatus: status, error }
    } catch (e) {
      console.warn(`❌ Whapi ${label} falhou:`, chatId, e?.message || e)
      return { ok: false, chatId, error: e?.message || String(e) }
    }
  }
  // `quietNaoExistia`: para quem CONSULTA (ler o nome do chat de um contato que talvez nem
  // tenha conversa no celular), "não existe" é resposta normal, não incidente — sem isto a
  // varredura de nomes enche o log com um aviso por contato.
  if (opts?.quietNaoExistia !== true) {
    console.warn(`⚠️ Whapi ${label}: nenhum dos endereços existe no canal`, candidatos.join(' · '))
  }
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
function envLigado(nome, padrao = true) {
  const raw = String(process.env[nome] ?? '').trim().toLowerCase()
  if (!raw) return padrao
  if (['1', 'true', 'yes', 'sim', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(raw)) return false
  return padrao
}

function envMs(nome, padrao) {
  const n = Number(String(process.env[nome] ?? '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : padrao
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

/** O chat ainda está no canal? Consulta o endereço EXATO que o DELETE aceitou. */
async function chatAindaExiste(cfg, chatId) {
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: `/chats/${encodeURIComponent(chatId)}` })
    if (Number(status) === 404) return false
    if (!ok) return null // indeterminado: não afirmar nada
    return isWhapiSuccessBody(ok, data)
  } catch {
    return null
  }
}

/**
 * Apaga a conversa do contato na conta conectada — TODOS os endereços dele — e confere.
 *
 * **O contato pode ter DOIS chats.** Medido no canal de produção em 21/10, no mesmo número:
 *
 *   5534999911246@s.whatsapp.net  (com o 9º)  → chat criado agora
 *   553499911246@s.whatsapp.net   (sem o 9º)  → "Miguel WM", com o histórico
 *
 * São chats SEPARADOS para o WhatsApp. Enquanto esta função parava no primeiro endereço que
 * respondia, apagávamos um e o gêmeo continuava na lista — era exatamente o relato "apagou,
 * mas ficou o card e a última mensagem". Por isso o laço agora percorre **todos** os candidatos
 * em vez de parar no primeiro: 404 = aquele endereço não existe (segue), erro real PARA.
 *
 * Isso é coerente com o resto do sistema, que já trata as formas ±9º dígito como a MESMA
 * identidade (`possiblePhonesForWhatsappIdentity`, candidatos de envio): se o envio alcança as
 * duas, apagar a conversa tem de alcançar as duas.
 *
 * Depois de apagar, CONFERE: o 200 do provedor não prova que o chat saiu. Sobrando algum
 * endereço, tenta de novo e, por fim, ARQUIVA os sobreviventes — não é exclusão, mas tira da
 * lista principal, é reversível e não toca em nada do lado do cliente.
 *
 * O que NÃO fazemos: revogar a mensagem residual. A Whapi só tem `DELETE /messages/{id}`, que
 * apaga **para todos** — apagaria a mensagem no aparelho do CLIENTE para limpar a nossa lista.
 *
 * Env: `WHAPI_CHAT_DELETE_VERIFY` (padrão on) · `WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK` (padrão on)
 * · `WHAPI_CHAT_DELETE_RETRY_DELAY_MS` (padrão 1200).
 *
 * @returns {Promise<ResultadoAcaoChat & {apagados?: string[], residuo?: boolean, arquivado?: boolean, verificado?: boolean}>}
 */
async function deleteChat(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const candidatos = chatIdCandidates(phone)
  if (!candidatos.length) return { ok: false, error: 'Chat inválido.' }

  /** Apaga UM endereço. @returns {'apagado'|'nao_existe'|{erro}} */
  const apagarEndereco = async (chatId) => {
    try {
      const { ok, status, data } = await del({
        token: cfg.token,
        endpoint: `/chats/${encodeURIComponent(chatId)}`,
        companyId: cfg.companyId,
        whatsappInstanceId: cfg.whatsappInstanceId,
        skipSendGuard: true,
      })
      if (isWhapiSuccessBody(ok, data)) return 'apagado'
      if (Number(status) === 404) return 'nao_existe'
      const error = String(data?.error?.message || data?.error || `HTTP ${status}`)
      console.warn('❌ Whapi deleteChat recusado:', chatId, `HTTP ${status}`, error.slice(0, 160))
      return { erro: { chatId, httpStatus: status, error } }
    } catch (e) {
      console.warn('❌ Whapi deleteChat falhou:', chatId, e?.message || e)
      return { erro: { chatId, error: e?.message || String(e) } }
    }
  }

  /** Varre todos os endereços. Para no primeiro erro REAL (404 não é erro). */
  const apagarTodos = async (lista) => {
    const apagados = []
    for (const chatId of lista) {
      const r = await apagarEndereco(chatId)
      if (r === 'apagado') apagados.push(chatId)
      else if (r && r.erro) return { apagados, erro: r.erro }
    }
    return { apagados, erro: null }
  }

  const { apagados, erro } = await apagarTodos(candidatos)
  if (!apagados.length) {
    if (erro) return { ok: false, ...erro }
    console.warn('⚠️ Whapi deleteChat: nenhum dos endereços existe no canal', candidatos.join(' · '))
    return { ok: false, naoExistia: true, httpStatus: 404 }
  }

  const base = { ok: true, chatId: apagados[0], apagados }
  if (!envLigado('WHAPI_CHAT_DELETE_VERIFY')) return base

  // `indeterminado`: a consulta de conferência falhou (nem 200 nem 404). Não dá para afirmar
  // que sumiu nem que sobrou — então não inventa resíduo E não carimba "verificado".
  const sobreviventes = async () => {
    const restantes = []
    let indeterminado = false
    for (const chatId of apagados) {
      const estado = await chatAindaExiste(cfg, chatId)
      if (estado === true) restantes.push(chatId)
      else if (estado === null) indeterminado = true
    }
    return { restantes, indeterminado }
  }

  let { restantes, indeterminado } = await sobreviventes()
  if (!restantes.length) return { ...base, verificado: !indeterminado }

  // Sobrou: 2ª tentativa com a visão do canal já atualizada.
  await esperar(envMs('WHAPI_CHAT_DELETE_RETRY_DELAY_MS', 1200))
  await apagarTodos(restantes)
  ;({ restantes, indeterminado } = await sobreviventes())
  if (!restantes.length) return { ...base, verificado: !indeterminado }

  console.warn('⚠️ Whapi deleteChat: continua na lista depois de 2 tentativas', restantes.join(' · '))
  if (!envLigado('WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK')) {
    return { ...base, verificado: true, residuo: true, arquivado: false }
  }
  const arq = await archiveChat(phone, opts)
  console.warn('⚠️ Whapi deleteChat: arquivado como último recurso (sai da lista principal, não é exclusão)', restantes.join(' · '), 'ok:', arq?.ok === true)
  return { ...base, verificado: true, residuo: true, arquivado: arq?.ok === true }
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
 *
 * Endereçado por `runOnChatCandidates`: com `toWhapiChatId` sozinho esta leitura caía no MESMO
 * 404 silencioso das ações de chat (o 9º dígito), medido no canal em 21/10:
 *   GET /chats/553497829258@s.whatsapp.net  → 200 (o chat real, com `name`)
 *   GET /chats/5534997829258@s.whatsapp.net → 404 "specified chat not found"
 */
async function getChat(chat, opts = {}) {
  const r = await runOnChatCandidates('getChat', chat, opts, (cfg, chatId) => get({
    token: cfg.token,
    endpoint: `/chats/${encodeURIComponent(chatId)}`,
  }))
  if (!r.ok) {
    if (r.naoExistia) {
      return { ok: false, httpStatus: r.httpStatus ?? 404, error: 'Chat não encontrado no canal.' }
    }
    return r
  }
  const body = r.data && typeof r.data === 'object' ? r.data : null
  const inner = body?.chat && typeof body.chat === 'object' ? body.chat : body
  return { ok: true, chat: inner || null, chatId: r.chatId, httpStatus: r.httpStatus }
}

/**
 * Nome que o WhatsApp do celular conectado mostra para este chat — o nome SALVO NA AGENDA,
 * que é o nome pelo qual o atendente procura o cliente na lista.
 *
 * Medido no canal de produção em 21/10 (MCP, só leitura). Para um contato que o atendente tem
 * salvo, `/contacts/{id}` responde SEM nome e só `/chats/{id}` traz o nome da agenda:
 *   GET /contacts/553497829258             → {"phonebook":false,"saved":false,"id":"553497829258"}
 *   GET /chats/553497829258@s.whatsapp.net → {"name":"Claudia DB", …, last_message.from_name:"❤"}
 * O webhook, por sua vez, só traz `from_name` = pushname do CLIENTE ("❤", "Rayssa", "Agro
 * Frutal"), que não é o nome salvo ("Claudia DB", "DISTRIBUIDORA NEVADA LTDA", "Agro Fixo").
 * Por isso o nome da agenda sai daqui, e não de `/contacts`.
 *
 * @returns {Promise<string|null>} nome do chat, ou null quando o chat não existe / não tem nome
 */
async function getChatBookName(phone, opts = {}) {
  const r = await getChat(phone, { ...opts, quietNaoExistia: true })
  if (!r?.ok || !r.chat || typeof r.chat !== 'object') return null
  const name = r.chat.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
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
  getChatBookName,
  getGroups,
  getGroup,
  patchChat,
  pinChat,
  muteChat,
}
