/**
 * Histórico de mensagens por chat — GET /messages/list/{ChatID}.
 * Devolve array no formato que oldMessagesSyncService / historyImport já leem
 * (id, fromMe/from_me, body, text.body, image.url/link, timestamp).
 * Com `opts.timeFrom` (só o botão "Buscar histórico") pagina com time_from e corta em 45 dias.
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId, historyChatIdCandidates } = require('./phones')
const { get } = require('./http')
const { extractArray, firstHttpUrl } = require('./parse')

const PAGE_MAX = 100
const MAX_PAGES = 20
/** Janela do botão: páginas de 100 até cobrir 45 dias sem varrer o arquivo inteiro. */
const HISTORY_MAX_PAGES = 40

function mediaObj(src) {
  if (!src) return undefined
  const url = typeof src === 'string' ? src : firstHttpUrl(src.link, src.url, src.file)
  if (!url) return undefined
  return {
    url,
    link: url,
    imageUrl: url,
    videoUrl: url,
    audioUrl: url,
    documentUrl: url,
    fileName: src.file_name || src.filename || src.name || undefined,
    caption: src.caption || undefined,
  }
}

function mapWhapiMessageForSync(m) {
  if (!m || typeof m !== 'object') return null
  const id = m.id != null ? String(m.id).trim() : ''
  if (!id) return null
  const type = String(m.type || 'text').toLowerCase()
  const fromMe = Boolean(m.from_me ?? m.fromMe)
  const textBody = String(
    (m.text && (m.text.body ?? m.text))
    || m.body
    || m.caption
    || m[type]?.caption
    || ''
  )
  const image = type === 'image' ? mediaObj(m.image) : undefined
  const video = type === 'video' ? mediaObj(m.video) : undefined
  const audio = (type === 'audio' || type === 'voice' || type === 'ptt')
    ? mediaObj(m.audio || m.voice)
    : undefined
  const document = (type === 'document' || type === 'file')
    ? mediaObj(m.document || m.file)
    : undefined
  const sticker = type === 'sticker' ? mediaObj(m.sticker) : undefined
  return {
    id,
    messageId: id,
    fromMe,
    from_me: fromMe,
    type: type === 'text' ? 'chat' : type,
    timestamp: m.timestamp,
    momment: m.timestamp,
    body: textBody,
    caption: m.caption || m[type]?.caption || undefined,
    text: { body: textBody, message: textBody },
    message: textBody,
    ...(image ? { image, imageUrl: image.url } : {}),
    ...(video ? { video, videoUrl: video.url } : {}),
    ...(audio ? { audio, audioUrl: audio.url } : {}),
    ...(document ? { document, documentUrl: document.url, fileName: document.fileName } : {}),
    ...(sticker ? { sticker, stickerUrl: sticker.url } : {}),
    ...(m.location ? { location: m.location } : {}),
    from: m.from,
    chat_id: m.chat_id,
  }
}

function messageEpochSec(message) {
  const raw = Number(message?.timestamp ?? message?.momment)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw)
}

function safeChatIdTail(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.length <= 14 ? raw : `...${raw.slice(-14)}`
}

function historyTimeFrom(opts) {
  const n = Number(opts?.timeFrom)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

async function fetchChatMessagesPage(cfg, chatId, count, offset, timeFrom) {
  const extraParams = { count: String(count), offset: String(offset) }
  if (timeFrom) {
    extraParams.time_from = String(timeFrom)
    extraParams.sort = 'desc'
  }
  const { ok, data, status, text } = await get({
    token: cfg.token,
    endpoint: `/messages/list/${encodeURIComponent(chatId)}`,
    extraParams,
  })
  const raw = extractArray(data, ['messages', 'data', 'list'])
  return { ok, status, text, raw }
}

async function collectChatPages(cfg, chatId, limit, maxPages, timeFrom, attempts) {
  const all = []
  const seen = new Set()
  let chatOk = false
  let error = null

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit
    let pageResult
    try {
      pageResult = await fetchChatMessagesPage(cfg, chatId, limit, offset, timeFrom)
    } catch (e) {
      error = e?.message || String(e)
      attempts.push({
        chatIdTail: safeChatIdTail(chatId),
        page: page + 1,
        offset,
        ok: false,
        status: null,
        count: 0,
        newCount: 0,
        error,
      })
      break
    }

    if (!pageResult.ok) {
      error = 'Whapi recusou a consulta de mensagens.'
      attempts.push({
        chatIdTail: safeChatIdTail(chatId),
        page: page + 1,
        offset,
        ok: false,
        status: pageResult.status ?? null,
        count: 0,
        newCount: 0,
        error,
      })
      break
    }

    chatOk = true
    let crossedWindow = false
    let newInPage = 0
    for (const item of pageResult.raw) {
      const sec = messageEpochSec(item)
      if (timeFrom && sec != null && sec < timeFrom) {
        crossedWindow = true
        continue
      }
      const mapped = mapWhapiMessageForSync(item)
      if (!mapped || seen.has(mapped.id)) continue
      seen.add(mapped.id)
      all.push(mapped)
      newInPage += 1
    }

    attempts.push({
      chatIdTail: safeChatIdTail(chatId),
      page: page + 1,
      offset,
      ok: true,
      status: pageResult.status ?? null,
      count: pageResult.raw.length,
      newCount: newInPage,
      timeFrom: timeFrom || null,
      error: null,
    })

    if (!pageResult.raw.length || newInPage === 0 || pageResult.raw.length < limit || crossedWindow) break
  }

  return { chatOk, all, error }
}

async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  const returnDetails = opts?.returnDetails === true
  const endpoint = '/messages/list/{ChatID}'
  const empty = (overrides = {}) => (returnDetails
    ? { ok: false, data: [], endpoint, attempts: [], ...overrides }
    : [])
  if (!cfg) return empty({ error: 'Instância Whapi não configurada.' })

  const timeFrom = historyTimeFrom(opts)
  const chatIds = timeFrom
    ? historyChatIdCandidates(phone, opts?.chatIdCandidates)
    : [toWhapiChatId(phone)].filter(Boolean)
  if (!chatIds.length) return empty({ error: 'Nenhum chatId válido para consultar mensagens.' })

  const limit = Math.min(PAGE_MAX, Math.max(1, Number(amount) || 10))
  const maxPages = timeFrom ? HISTORY_MAX_PAGES : (opts?.fetchAllPages === true ? MAX_PAGES : 1)
  // lastMessageId da UltraMSG é cursor; Whapi pagina por offset. Ignorado de propósito.
  void lastMessageId

  const attempts = []
  let firstEmptyOk = null
  let lastError = null

  try {
    for (const chatId of chatIds) {
      const collected = await collectChatPages(cfg, chatId, limit, maxPages, timeFrom, attempts)
      if (collected.chatOk && collected.all.length > 0) {
        const result = { ok: true, data: collected.all, chatId, endpoint, timeFrom, attempts }
        return returnDetails ? result : collected.all
      }
      if (collected.chatOk) {
        if (!firstEmptyOk) firstEmptyOk = { chatId, data: [] }
        if (!timeFrom) break
        continue
      }
      lastError = collected.error || lastError
      if (!timeFrom) break
    }
  } catch (e) {
    return empty({ error: e?.message || String(e), attempts })
  }

  if (firstEmptyOk) {
    const result = { ok: true, data: [], chatId: firstEmptyOk.chatId, endpoint, timeFrom, attempts }
    return returnDetails ? result : []
  }

  return empty({
    error: lastError || 'Whapi recusou a consulta de mensagens.',
    attempts,
  })
}

module.exports = {
  getChatMessages,
  mapWhapiMessageForSync,
}
