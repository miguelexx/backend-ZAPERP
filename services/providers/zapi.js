/**
 * Provider Z-API (WhatsApp via conexão QR Code).
 * Envio via REST; recebimento via webhook POST /webhooks/zapi.
 *
 * Variáveis .env obrigatórias para envio:
 *   ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN
 * Opcionais: ZAPI_BASE_URL, APP_URL (mídia)
 */

const { normalizePhoneBR, toZapiSendFormat, possiblePhonesBR } = require('../../helpers/phoneHelper')

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || ''
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || ''
const ZAPI_BASE_URL = (process.env.ZAPI_BASE_URL || 'https://api.z-api.io').replace(/\/$/, '')
const ZAPI_CLIENT_TOKEN = (process.env.ZAPI_CLIENT_TOKEN || '').trim()

function getBasePath() {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) return null
  return `${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`
}

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN
  return headers
}

function logClientTokenHint(errBody) {
  const body = String(errBody || '').toLowerCase()
  if (body.includes('client-token') && body.includes('not configured')) {
    console.warn('⚠️ Z-API exige Client-Token. No .env do backend adicione: ZAPI_CLIENT_TOKEN=seu_token')
    console.warn('   Obtenha o token em: painel Z-API → Segurança → Token da conta')
  }
}

/** Normaliza telefone: preserva IDs de grupo; individual usa padrão BR. */
function normalizePhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  // grupos: preserve formatos usados pela Z-API/WhatsApp
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return s
  return normalizePhoneBR(s || '')
}

function isGroupIdDigits(d) {
  const digits = String(d || '').replace(/\D/g, '')
  return digits.startsWith('120') && digits.length >= 15 && digits.length <= 22
}

/** Candidatos de envio (profissional): tenta variações aceitas pela Z-API para grupos. */
function phoneCandidatesForSend(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return []

  // se já veio com sufixo de grupo/JID, tente também o puro dígito
  if (raw.endsWith('@g.us') || raw.includes('-group')) {
    const digits = raw.replace(/\D/g, '')
    const list = [raw]
    // se vier -group, tente também @g.us
    if (raw.includes('-group') && digits) list.push(`${digits}@g.us`)
    if (digits) list.push(digits)
    return Array.from(new Set(list.filter(Boolean)))
  }

  const norm = normalizePhone(raw)
  const digits = String(norm || '').replace(/\D/g, '')
  if (!digits) return []

  if (isGroupIdDigits(digits)) {
    // ✅ Z-API (grupos novos): formato oficial é "120...-group" (docs group-metadata).
    // Priorizar "-group" evita "Phone number does not exist" no delivery.
    return Array.from(new Set([`${digits}-group`, `${digits}@g.us`, digits]))
  }

  const sendFmt = toZapiSendFormat(digits)
  return sendFmt ? [sendFmt] : []
}

const GROUP_SEND_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const groupSendCache = new Map() // digits -> { exp: number, candidates: string[] }

async function getGroupMetadata(groupId) {
  const basePath = getBasePath()
  if (!basePath) return null
  const gid = String(groupId || '').trim()
  if (!gid) return null
  try {
    // docs têm inconsistência (GET vs POST). Tentamos ambos.
    let res = await fetch(`${basePath}/group-metadata/${encodeURIComponent(gid)}`, {
      method: 'GET',
      headers: getHeaders()
    })
    if (!res.ok && (res.status === 405 || res.status === 404)) {
      res = await fetch(`${basePath}/group-metadata/${encodeURIComponent(gid)}`, {
        method: 'POST',
        headers: getHeaders()
      })
    }
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

async function phoneCandidatesForSendAsync(phone) {
  const base = phoneCandidatesForSend(phone)
  const raw = String(phone || '').trim()
  const digits = raw.replace(/\D/g, '')
  if (!isGroupIdDigits(digits)) return base

  const now = Date.now()
  const cached = groupSendCache.get(digits)
  if (cached && cached.exp > now && Array.isArray(cached.candidates) && cached.candidates.length) {
    return cached.candidates
  }

  // confirma/resolve via group-metadata (formato preferido "-group")
  const meta =
    (await getGroupMetadata(`${digits}-group`).catch(() => null)) ||
    (await getGroupMetadata(digits).catch(() => null)) ||
    (await getGroupMetadata(`${digits}@g.us`).catch(() => null))

  const canonical = meta?.phone ? String(meta.phone).trim() : ''
  const candidates = canonical ? Array.from(new Set([canonical, ...base])) : base
  groupSendCache.set(digits, { exp: now + GROUP_SEND_CACHE_TTL_MS, candidates })
  return candidates
}

async function postJsonWithCandidates({ basePath, endpoint, phoneCandidates, buildBody, okLogLabel }) {
  for (const num of phoneCandidates) {
    try {
      const res = await fetch(`${basePath}${endpoint}`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(buildBody(num))
      })

      const bodyText = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(bodyText)
        console.warn(`❌ Z-API falha ao enviar (${okLogLabel}):`, String(num || '').slice(-12), res.status, String(bodyText || '').slice(0, 200))
        continue
      }

      let data = null
      try { data = bodyText ? JSON.parse(bodyText) : null } catch { data = null }
      const err = data?.error || data?.messageError || data?.errorMessage || null
      if (err) {
        console.warn(`❌ Z-API envio retornou erro (200) (${okLogLabel}):`, String(num || '').slice(-12), String(err).slice(0, 200))
        continue
      }

      const msgId = data?.messageId || data?.zaapId || null
      console.log(`✅ Z-API enviado (${okLogLabel}):`, String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
      return true
    } catch (e) {
      console.warn(`❌ Z-API erro ao enviar (${okLogLabel}):`, String(num || '').slice(-12), e?.message || e)
    }
  }
  return false
}

/**
 * Para consulta (perfil/metadata), tente o número "como está" e também a variação com/sem 9.
 * A Z-API/WhatsApp pode ter o contato registrado em um dos formatos.
 */
function phoneCandidatesForLookup(phone) {
  const norm = normalizePhone(phone)
  const candidates = possiblePhonesBR(norm)
  // garantir que também tentamos a versão "send format" (com 9)
  const sendFmt = toZapiSendFormat(norm)
  if (sendFmt) candidates.push(sendFmt)
  return Array.from(new Set(candidates.filter(Boolean)))
}

/**
 * Envia mensagem de texto.
 * @param {string} phone - Número no formato DDI+DDD+NUMERO (apenas dígitos ou será normalizado)
 * @param {string} message - Texto da mensagem
 * @returns {Promise<boolean>} true se enviado com sucesso
 */
async function sendText(phone, message) {
  const basePath = getBasePath()
  if (!basePath) return false
  const nums = await phoneCandidatesForSendAsync(phone)
  if (!nums.length || !message) return false
  try {
    for (const num of nums) {
      const res = await fetch(`${basePath}/send-text`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ phone: num, message: String(message).trim() })
      })

      const bodyText = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(bodyText)
        console.warn('❌ Z-API falha ao enviar texto:', String(num || '').slice(-12), res.status, String(bodyText || '').slice(0, 200))
        continue
      }

      // às vezes a API retorna 200 com "error"
      let data = null
      try { data = bodyText ? JSON.parse(bodyText) : null } catch { data = null }
      const err = data?.error || data?.messageError || data?.errorMessage || null
      if (err) {
        console.warn('❌ Z-API envio retornou erro (200):', String(num || '').slice(-12), String(err).slice(0, 200))
        continue
      }

      const msgId = data?.messageId || data?.zaapId || null
      console.log('✅ Z-API mensagem enviada:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
      return true
    }
    return false
  } catch (e) {
    console.error('❌ Erro Z-API sendText:', e.message)
    return false
  }
}

/**
 * Envia imagem por URL.
 * @param {string} phone - Número (apenas dígitos)
 * @param {string} url - URL pública da imagem
 * @param {string} [caption] - Legenda opcional
 * @returns {Promise<boolean>}
 */
async function sendImage(phone, url, caption = '') {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone)
    if (!nums.length || !url) return false
    const safeUrl = String(url).trim()
    const safeCaption = caption ? String(caption).trim() : ''
    return await postJsonWithCandidates({
      basePath,
      endpoint: '/send-image',
      phoneCandidates: nums,
      okLogLabel: 'imagem',
      buildBody: (num) => {
        const body = { phone: num, image: safeUrl }
        if (safeCaption) body.caption = safeCaption
        return body
      }
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendImage:', e.message)
    return false
  }
}

/**
 * Envia áudio por URL (ou base64).
 * @param {string} phone - Número (apenas dígitos ou JID grupo)
 * @param {string} audioUrl - URL pública do áudio
 * @returns {Promise<boolean>}
 */
async function sendAudio(phone, audioUrl) {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone)
    const a = String(audioUrl || '').trim()
    if (!nums.length || !a) return false
    return await postJsonWithCandidates({
      basePath,
      endpoint: '/send-audio',
      phoneCandidates: nums,
      okLogLabel: 'áudio',
      buildBody: (num) => ({ phone: num, audio: a })
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendAudio:', e.message)
    return false
  }
}

/**
 * Envia documento/arquivo por URL.
 * @param {string} phone - Número (apenas dígitos)
 * @param {string} url - URL pública do arquivo
 * @param {string} [fileName] - Nome do arquivo (opcional)
 * @returns {Promise<boolean>}
 */
async function sendFile(phone, url, fileName = '') {
  const basePath = getBasePath()
  if (!basePath) return false
  const nums = await phoneCandidatesForSendAsync(phone)
  if (!nums.length || !url) return false
  const ext = fileName ? String(fileName).split('.').pop() : 'pdf'
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'pdf'
  try {
    const safeUrl = String(url).trim()
    const safeName = fileName ? String(fileName).trim() : ''
    // endpoint inclui extensão
    return await postJsonWithCandidates({
      basePath,
      endpoint: `/send-document/${safeExt}`,
      phoneCandidates: nums,
      okLogLabel: 'arquivo',
      buildBody: (num) => {
        const body = { phone: num, document: safeUrl }
        if (safeName) body.fileName = safeName
        return body
      }
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendFile:', e.message)
    return false
  }
}

/**
 * Envia figurinha (sticker) por URL ou base64.
 * POST /send-sticker
 *
 * @param {string} phone - Número (apenas dígitos ou JID grupo)
 * @param {string} sticker - URL pública ou base64 (data:image/png;base64,...)
 * @param {{ stickerAuthor?: string }} [opts]
 * @returns {Promise<boolean>}
 */
async function sendSticker(phone, sticker, opts = {}) {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone)
    const s = String(sticker || '').trim()
    if (!nums.length || !s) return false
    const author = opts?.stickerAuthor ? String(opts.stickerAuthor).trim() : ''
    return await postJsonWithCandidates({
      basePath,
      endpoint: '/send-sticker',
      phoneCandidates: nums,
      okLogLabel: 'figurinha',
      buildBody: (num) => {
        const body = { phone: num, sticker: s }
        if (author) body.stickerAuthor = author
        return body
      }
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendSticker:', e.message)
    return false
  }
}

/**
 * Lista contatos do WhatsApp (celular conectado).
 * GET /contacts?page=1&pageSize=100
 * @returns {Promise<Array<{phone, name?, short?, vname?, notify?, imgUrl?}>>}
 */
async function getContacts(page = 1, pageSize = 100) {
  const basePath = getBasePath()
  if (!basePath) return []
  try {
    const res = await fetch(
      `${basePath}/contacts?page=${Number(page)}&pageSize=${Number(pageSize)}`,
      { method: 'GET', headers: getHeaders() }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('Z-API getContacts:', e.message)
    return []
  }
}

/**
 * Busca URL da foto de perfil de um número.
 * GET /profile-picture?phone=5511999999999
 * @returns {Promise<string|null>} URL da foto ou null
 */
async function getProfilePicture(phone) {
  const basePath = getBasePath()
  if (!basePath) return null
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return null

    for (const num of nums) {
      const res = await fetch(
        `${basePath}/profile-picture?phone=${encodeURIComponent(num)}`,
        { method: 'GET', headers: getHeaders() }
      )
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        logClientTokenHint(errBody)
        console.warn('❌ Z-API getProfilePicture falhou:', num?.slice(-6), res.status, String(errBody || '').slice(0, 200))
        continue
      }
      const data = await res.json().catch(() => null)
      // Z-API pode retornar {link:"..."} OU [{link:"..."}]
      const obj = Array.isArray(data) ? (data[0] || null) : data
      const linkRaw = obj?.link ?? obj?.imgUrl ?? null
      const link = linkRaw != null ? String(linkRaw).trim() : ''
      // Alguns casos retornam "null" como string quando não há foto.
      if (!link || link.toLowerCase() === 'null' || link.toLowerCase() === 'undefined') continue
      if (!link.startsWith('http')) continue
      return link
    }
    return null
  } catch (e) {
    console.error('Z-API getProfilePicture:', e.message)
    return null
  }
}

/**
 * Metadados do contato (nome, foto, etc.) — GET /contacts/{phone}
 * @returns {Promise<{phone?, name?, short?, vname?, notify?, imgUrl?, about?}|null>}
 */
async function getContactMetadata(phone) {
  const basePath = getBasePath()
  if (!basePath) return null
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return null
    for (const num of nums) {
      const res = await fetch(`${basePath}/contacts/${encodeURIComponent(num)}`, {
        method: 'GET',
        headers: getHeaders()
      })
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      if (data && typeof data === 'object') return data
    }
    return null
  } catch (e) {
    console.error('Z-API getContactMetadata:', e.message)
    return null
  }
}

/**
 * Envia vídeo por URL.
 * @param {string} phone - Número (apenas dígitos ou JID grupo)
 * @param {string} videoUrl - URL pública do vídeo
 * @param {string} [caption] - Legenda opcional
 * @returns {Promise<boolean>}
 */
async function sendVideo(phone, videoUrl, caption = '') {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone)
    const v = String(videoUrl || '').trim()
    if (!nums.length || !v) return false
    const safeCaption = caption ? String(caption).trim() : ''
    return await postJsonWithCandidates({
      basePath,
      endpoint: '/send-video',
      phoneCandidates: nums,
      okLogLabel: 'vídeo',
      buildBody: (num) => {
        const body = { phone: num, video: v }
        if (safeCaption) body.caption = safeCaption
        return body
      }
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendVideo:', e.message)
    return false
  }
}

/**
 * Busca mensagens de um chat (histórico).
 * GET /chat-messages/{phone}?amount=10&lastMessageId=...
 *
 * @param {string} phone
 * @param {number} [amount=10]
 * @param {string|null} [lastMessageId=null]
 * @returns {Promise<Array<object>>}
 */
async function getChatMessages(phone, amount = 10, lastMessageId = null) {
  const basePath = getBasePath()
  if (!basePath) return []
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return []

    for (const num of nums) {
      const qs = new URLSearchParams()
      qs.set('amount', String(Math.max(1, Number(amount) || 10)))
      if (lastMessageId) qs.set('lastMessageId', String(lastMessageId))

      const res = await fetch(`${basePath}/chat-messages/${encodeURIComponent(num)}?${qs.toString()}`, {
        method: 'GET',
        headers: getHeaders()
      })
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        logClientTokenHint(errBody)
        console.warn('❌ Z-API getChatMessages falhou:', num?.slice(-6), res.status, String(errBody || '').slice(0, 200))
        continue
      }
      const data = await res.json().catch(() => null)
      return Array.isArray(data) ? data : []
    }
    return []
  } catch (e) {
    console.error('Z-API getChatMessages:', e.message)
    return []
  }
}

module.exports = {
  sendText,
  sendImage,
  sendFile,
  sendAudio,
  sendVideo,
  sendSticker,
  getContacts,
  getProfilePicture,
  getContactMetadata,
  getChatMessages,
  normalizePhone,
  isConfigured: !!ZAPI_INSTANCE_ID && !!ZAPI_TOKEN
}
