/**
 * Histórico de mensagens por chat — GET /messages/list/{ChatID}.
 * Devolve array no formato que oldMessagesSyncService / historyImport já leem
 * (id, fromMe/from_me, body, text.body, image.url/link, timestamp).
 */

const { resolveConfig } = require('./config')
const { toWhapiChatId } = require('./phones')
const { get } = require('./http')
const { extractArray, firstHttpUrl } = require('./parse')

const PAGE_MAX = 100
const MAX_PAGES = 20

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

async function fetchChatMessagesPage(cfg, chatId, count, offset) {
  const { ok, data, status, text } = await get({
    token: cfg.token,
    endpoint: `/messages/list/${encodeURIComponent(chatId)}`,
    extraParams: { count: String(count), offset: String(offset) },
  })
  const raw = extractArray(data, ['messages', 'data', 'list'])
  return { ok, status, text, raw }
}

async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  const returnDetails = opts?.returnDetails === true
  const empty = (overrides = {}) => (returnDetails
    ? { ok: false, data: [], endpoint: '/messages/list/{ChatID}', ...overrides }
    : [])
  if (!cfg) return empty({ error: 'Instância Whapi não configurada.' })
  const chatId = toWhapiChatId(phone)
  if (!chatId) return empty({ error: 'Nenhum chatId válido para consultar mensagens.' })

  const limit = Math.min(PAGE_MAX, Math.max(1, Number(amount) || 10))
  const maxPages = opts?.fetchAllPages === true ? MAX_PAGES : 1
  const all = []
  const seen = new Set()
  // lastMessageId da UltraMSG é cursor; Whapi pagina por offset. Ignorado de propósito.
  void lastMessageId

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * limit
      const { ok, raw } = await fetchChatMessagesPage(cfg, chatId, limit, offset)
      if (!ok) {
        if (page === 0) return empty({ error: 'Whapi recusou a consulta de mensagens.' })
        break
      }
      let newInPage = 0
      for (const item of raw) {
        const mapped = mapWhapiMessageForSync(item)
        if (!mapped) continue
        if (seen.has(mapped.id)) continue
        seen.add(mapped.id)
        all.push(mapped)
        newInPage += 1
      }
      if (!raw.length || newInPage === 0 || raw.length < limit) break
    }
  } catch (e) {
    return empty({ error: e?.message || String(e) })
  }

  return returnDetails ? { ok: true, data: all } : all
}

module.exports = {
  getChatMessages,
  mapWhapiMessageForSync,
}
