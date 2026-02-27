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
 * @param {{ phoneId?: string, replyMessageId?: string }} [opts] - Opções extras
 *   replyMessageId: ID Z-API da mensagem que está sendo respondida (para reply nativo no WhatsApp)
 * @returns {Promise<{ ok: boolean, messageId: string|null }>} ok e messageId (quando disponível)
 */
async function sendText(phone, message, opts = {}) {
  const basePath = getBasePath()
  if (!basePath) return { ok: false, messageId: null }
  const nums = await phoneCandidatesForSendAsync(phone)
  if (!nums.length || !message) return { ok: false, messageId: null }

  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null

  try {
    for (const num of nums) {
      const body = { phone: num, message: String(message).trim() }
      // reply nativo WhatsApp: Z-API aceita "replyMessageId" no corpo
      if (replyMessageId) body.replyMessageId = replyMessageId

      const res = await fetch(`${basePath}/send-text`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
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
      console.log('✅ Z-API mensagem enviada:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '', replyMessageId ? `[reply a ${String(replyMessageId).slice(0, 10)}...]` : '')
      return { ok: true, messageId: msgId ? String(msgId) : null }
    }
    return { ok: false, messageId: null }
  } catch (e) {
    console.error('❌ Erro Z-API sendText:', e.message)
    return { ok: false, messageId: null }
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

/**
 * Configura automaticamente as URLs de webhook no painel Z-API via API REST.
 * Chamado ao conectar a instância ou no startup do backend.
 *
 * Z-API endpoints:
 *   PUT /update-webhook-received    → mensagens recebidas (incoming)
 *   PUT /update-webhook-delivery    → DeliveryCallback (confirmação de envio)
 *   PUT /update-webhook-status      → MessageStatusCallback (READ/RECEIVED/PLAYED)
 *   PUT /update-webhook-disconnected → disconnect event
 *   PUT /update-webhook-connected   → connect event
 *   PUT /update-webhook-chat-presence → PresenceChatCallback (digitando, online)
 *   PUT /update-notify-sent-by-me   → ativa envio ao webhook de mensagens enviadas pelo CELULAR (espelhamento)
 */
async function configureWebhooks(appUrl) {
  const basePath = getBasePath()
  if (!basePath || !appUrl) return

  const base = String(appUrl).replace(/\/$/, '')

  // Inclui o token como query param nas URLs registradas no Z-API.
  // O Z-API envia o token de volta ao chamar o webhook (?token=xxx),
  // que é então validado pelo middleware requireWebhookToken.
  const webhookToken = String(process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix  = webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''

  const mainUrl     = `${base}/webhooks/zapi${tokenSuffix}`
  const statusUrl   = `${base}/webhooks/zapi/status${tokenSuffix}`
  const connUrl     = `${base}/webhooks/zapi/connection${tokenSuffix}`
  const presenceUrl = `${base}/webhooks/zapi/presence${tokenSuffix}`

  // Cada entrada tem candidatos de endpoint (Z-API mudou nomes entre versões).
  // Tentamos todos em sequência e paramos no primeiro que retornar 2xx.
  const configs = [
    { label: 'received',     value: mainUrl,     candidates: ['/update-webhook-received', '/update-on-message-received'] },
    { label: 'delivery',     value: mainUrl,     candidates: ['/update-webhook-delivery', '/update-on-message-delivery'] },
    { label: 'status',       value: statusUrl,   candidates: ['/update-on-message-status', '/update-webhook-status', '/update-webhook-on-message-status'] },
    { label: 'disconnected', value: connUrl,     candidates: ['/update-webhook-disconnected', '/update-on-disconnected'] },
    { label: 'connected',    value: connUrl,     candidates: ['/update-webhook-connected', '/update-on-connected'] },
    { label: 'presence',     value: presenceUrl, candidates: ['/update-webhook-chat-presence', '/update-on-chat-presence'] },
  ]

  const putBody = async (endpoint, body) => {
    const res = await fetch(`${basePath}${endpoint}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(body)
    })
    return res.ok || res.status === 204 || res.status === 200
  }

  const results = []
  for (const { label, value, candidates } of configs) {
    let ok = false
    for (const endpoint of candidates) {
      try {
        // Received: enviar notifySentByMe no mesmo body (doc Z-API: opcional em value + notifySentByMe)
        const body = label === 'received' ? { value, notifySentByMe: true } : { value }
        ok = await putBody(endpoint, body)
        if (ok) break
      } catch (_) {}
    }
    if (!ok) {
      console.warn(`⚠️ Z-API configureWebhooks [${label}]: todos os endpoints falharam. Configure manualmente: ${value}`)
    }
    results.push({ label, ok })
  }

  // Endpoint dedicado para notifySentByMe — tenta múltiplos formatos para compatibilidade com versões diferentes da Z-API.
  // Z-API v1: { value: "URL", notifySentByMe: true }  (já enviado no body do received acima)
  // Z-API v2: endpoint dedicado /update-notify-sent-by-me com { value: true }
  // Z-API v3+: endpoint /update-on-sent-by-me ou toggle simples
  const notifyCandidates = [
    { endpoint: '/update-notify-sent-by-me',  body: { value: true } },
    { endpoint: '/update-notify-sent-by-me',  body: { value: mainUrl, notifySentByMe: true } },
    { endpoint: '/update-on-sent-by-me',      body: { value: true } },
    { endpoint: '/update-on-sent-by-me',      body: { value: mainUrl } },
  ]
  let notifyOk = false
  for (const { endpoint, body } of notifyCandidates) {
    try {
      const ok = await putBody(endpoint, body)
      if (ok) { notifyOk = true; break }
    } catch (_) {}
  }
  if (notifyOk) {
    console.log('✅ Z-API notifySentByMe ativado: mensagens enviadas pelo celular serão enviadas ao webhook')
  } else {
    console.warn('⚠️ Z-API notifySentByMe: não foi possível ativar via API. Ative manualmente no painel Z-API: "Notificar mensagens enviadas por mim"')
  }
  results.push({ label: 'notifySentByMe', ok: notifyOk })

  const allOk = results.every(r => r.ok)
  if (allOk) {
    console.log('✅ Z-API webhooks configurados automaticamente')
    console.log(`   Mensagens (recebido + enviado por mim): ${mainUrl}`)
    console.log(`   Status (leitura/entrega): ${statusUrl}`)
    console.log(`   Conexão: ${connUrl} | Presença (digitando): ${presenceUrl}`)
  } else {
    const failed = results.filter(r => !r.ok).map(r => r.label)
    console.warn('⚠️ Z-API configureWebhooks: configure manualmente no painel Z-API:')
    console.warn(`   "Ao receber" + "Ao enviar": ${mainUrl}`)
    console.warn(`   "Receber status da mensagem": ${statusUrl}`)
    console.warn(`   "Ao conectar" + "Ao desconectar": ${connUrl}`)
    console.warn(`   "Status do chat" (presença/digitando): ${presenceUrl}`)
    if (failed.includes('notifySentByMe')) {
      console.warn('   Ative "Notificar mensagens enviadas por mim" para espelhar mensagens do celular.')
    }
    if (failed.length) console.warn('   Itens não configurados via API:', failed.join(', '))
  }
  return results
}

/**
 * Atualiza a foto de perfil do número conectado à instância.
 * PUT /profile-picture  { value: "URL da imagem" }
 * @param {string} imageUrl - URL pública da imagem
 * @returns {Promise<boolean>}
 */
async function updateProfilePicture(imageUrl) {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const res = await fetch(`${basePath}/profile-picture`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ value: String(imageUrl || '').trim() }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      logClientTokenHint(errBody)
      console.warn('❌ Z-API updateProfilePicture falhou:', res.status, String(errBody || '').slice(0, 200))
      return false
    }
    const data = await res.json().catch(() => null)
    return data?.value === true
  } catch (e) {
    console.error('Z-API updateProfilePicture:', e.message)
    return false
  }
}

/**
 * Atualiza o nome de perfil do número conectado à instância.
 * PUT /profile-name  { value: "Nome do perfil" }
 * @param {string} name - Novo nome de perfil
 * @returns {Promise<boolean>}
 */
async function updateProfileName(name) {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const res = await fetch(`${basePath}/profile-name`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ value: String(name || '').trim() }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      logClientTokenHint(errBody)
      console.warn('❌ Z-API updateProfileName falhou:', res.status, String(errBody || '').slice(0, 200))
      return false
    }
    const data = await res.json().catch(() => null)
    return data?.value === true
  } catch (e) {
    console.error('Z-API updateProfileName:', e.message)
    return false
  }
}

/**
 * Atualiza a descrição (status/bio) do número conectado à instância.
 * PUT /profile-description  { value: "Descrição do perfil" }
 * @param {string} description - Nova descrição de perfil
 * @returns {Promise<boolean>}
 */
async function updateProfileDescription(description) {
  const basePath = getBasePath()
  if (!basePath) return false
  try {
    const res = await fetch(`${basePath}/profile-description`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ value: String(description || '').trim() }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      logClientTokenHint(errBody)
      console.warn('❌ Z-API updateProfileDescription falhou:', res.status, String(errBody || '').slice(0, 200))
      return false
    }
    const data = await res.json().catch(() => null)
    return data?.value === true
  } catch (e) {
    console.error('Z-API updateProfileDescription:', e.message)
    return false
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
  configureWebhooks,
  updateProfilePicture,
  updateProfileName,
  updateProfileDescription,
  normalizePhone,
  isConfigured: !!ZAPI_INSTANCE_ID && !!ZAPI_TOKEN
}
