/**
 * Provider Z-API (WhatsApp via conexão QR Code).
 * Envio via REST; recebimento via webhook POST /webhooks/zapi.
 *
 * Multi-tenant: credenciais vêm de empresa_zapi por company_id.
 * ENV ZAPI_INSTANCE_ID/ZAPI_TOKEN/ZAPI_CLIENT_TOKEN = fallback opcional só em DEV.
 * Em produção, usar ENV para instância fixa causa erro "multi-tenant required".
 *
 * Mantido: ZAPI_BASE_URL, ZAPI_WEBHOOK_TOKEN
 */

const { normalizePhoneBR, toZapiSendFormat, possiblePhonesBR } = require('../../helpers/phoneHelper')
const { getEmpresaZapiConfig } = require('../zapiIntegrationService')
const { fetchWithRetry } = require('../../helpers/retryWithBackoff')
const { permitirEnvio } = require('../protecao/protecaoOrchestrator')
const circuitBreaker = require('../circuitBreakerZapi')

const ZAPI_BASE_URL = (process.env.ZAPI_BASE_URL || 'https://api.z-api.io').replace(/\/$/, '')
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || ''
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || ''
const ZAPI_CLIENT_TOKEN = (process.env.ZAPI_CLIENT_TOKEN || '').trim()
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production'

// Delay mínimo entre envios por empresa (anti-bloqueio: evita bursts que acionam detecção do WhatsApp)
const MIN_DELAY_BETWEEN_SENDS_MS = Math.min(500, Math.max(150, Number(process.env.ZAPI_SEND_DELAY_MS) || 280))
const lastSendPerCompany = new Map()

async function awaitSendDelay(companyId) {
  const key = companyId ?? 'default'
  const last = lastSendPerCompany.get(key) || 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_DELAY_BETWEEN_SENDS_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_BETWEEN_SENDS_MS - elapsed))
  }
  lastSendPerCompany.set(key, Date.now())
}

/**
 * Resolve config (basePath, headers) para chamadas à Z-API.
 * Prioridade: opts.companyId → empresa_zapi | fallback ENV (só se NODE_ENV !== production).
 * @param {{ companyId?: number }} [opts]
 * @returns {Promise<{ basePath: string, headers: object }|null>}
 */
async function resolveConfig(opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (companyId != null && companyId !== '') {
    const { config, error } = await getEmpresaZapiConfig(Number(companyId))
    if (error || !config) {
      console.warn(`[ZAPI] Empresa ${companyId} sem instância Z-API configurada (empresa_zapi). Envio cancelado.`, error || 'config vazio')
      return null
    }
    const base = ZAPI_BASE_URL
    const basePath = `${base}/instances/${encodeURIComponent(config.instance_id)}/token/${encodeURIComponent(config.instance_token)}`
    const headers = { 'Content-Type': 'application/json' }
    if (config.client_token) headers['Client-Token'] = config.client_token
    return { basePath, headers }
  }
  if (IS_PRODUCTION && (ZAPI_INSTANCE_ID || ZAPI_TOKEN)) {
    console.error('[ZAPI] multi-tenant required: use empresa_zapi por company_id. ZAPI_INSTANCE_ID/ZAPI_TOKEN em ENV são ignorados em produção.')
    return null
  }
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) return null
  const basePath = `${ZAPI_BASE_URL}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}/token/${encodeURIComponent(ZAPI_TOKEN)}`
  const headers = { 'Content-Type': 'application/json' }
  if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN
  return { basePath, headers }
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

async function getGroupMetadata(groupId, cfg) {
  if (!cfg?.basePath) return null
  const gid = String(groupId || '').trim()
  if (!gid) return null
  try {
    let res = await fetch(`${cfg.basePath}/group-metadata/${encodeURIComponent(gid)}`, {
      method: 'GET',
      headers: cfg.headers
    })
    if (!res.ok && (res.status === 405 || res.status === 404)) {
      res = await fetch(`${cfg.basePath}/group-metadata/${encodeURIComponent(gid)}`, {
        method: 'POST',
        headers: cfg.headers
      })
    }
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

async function phoneCandidatesForSendAsync(phone, cfg) {
  const base = phoneCandidatesForSend(phone)
  const raw = String(phone || '').trim()
  const digits = raw.replace(/\D/g, '')
  if (!isGroupIdDigits(digits)) return base
  if (!cfg) return base

  const now = Date.now()
  const cacheKey = `${cfg.basePath?.slice(0, 20) || ''}:${digits}`
  const cached = groupSendCache.get(cacheKey)
  if (cached && cached.exp > now && Array.isArray(cached.candidates) && cached.candidates.length) {
    return cached.candidates
  }

  const meta =
    (await getGroupMetadata(`${digits}-group`, cfg).catch(() => null)) ||
    (await getGroupMetadata(digits, cfg).catch(() => null)) ||
    (await getGroupMetadata(`${digits}@g.us`, cfg).catch(() => null))

  const canonical = meta?.phone ? String(meta.phone).trim() : ''
  const candidates = canonical ? Array.from(new Set([canonical, ...base])) : base
  groupSendCache.set(cacheKey, { exp: now + GROUP_SEND_CACHE_TTL_MS, candidates })
  return candidates
}

async function postJsonWithCandidates({ basePath, headers, endpoint, phoneCandidates, buildBody, okLogLabel }) {
  const h = headers || {}
  for (const num of phoneCandidates) {
    try {
      const res = await fetchWithRetry(`${basePath}${endpoint}`, {
        method: 'POST',
        headers: h,
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
 * @param {{ phoneId?: string, replyMessageId?: string, companyId?: number }} [opts] - Opções
 *   companyId: obrigatório em produção (multi-tenant)
 * @returns {Promise<{ ok: boolean, messageId: string|null }>}
 */
async function sendText(phone, message, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  const protecao = await permitirEnvio({
    company_id: companyId,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
    cliente_id: opts?.clienteId ?? opts?.cliente_id,
    requireOptIn: opts?.requireOptIn || false,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendText bloqueado por proteção:', protecao.reason || 'proteção')
    return { ok: false, messageId: null, blockedBy: protecao.reason }
  }
  await awaitSendDelay(companyId)
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    const cid = opts?.companyId ?? opts?.company_id
    if (cid != null) console.warn(`[ZAPI] sendText: sem config para company ${cid} — verifique empresa_zapi (company_id, instance_id, ativo=true)`)
    return { ok: false, messageId: null, error: 'Instância Z-API não configurada. Conecte o WhatsApp no painel de integrações.' }
  }
  const nums = await phoneCandidatesForSendAsync(phone, cfg)
  if (!nums.length) {
    return { ok: false, messageId: null, error: 'Número de telefone inválido. Use o formato 55 + DDD + número (ex: 5534999999999).' }
  }
  if (!message) return { ok: false, messageId: null, error: 'Mensagem vazia.' }

  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null

  try {
    let lastError = null
    for (const num of nums) {
      const body = { phone: num, message: String(message).trim() }
      // reply nativo WhatsApp: Z-API aceita "replyMessageId" no corpo
      if (replyMessageId) body.replyMessageId = replyMessageId

      const res = await fetchWithRetry(`${cfg.basePath}/send-text`, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(body)
      })

      const bodyText = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(bodyText)
        const errLower = String(bodyText || '').toLowerCase()
        if (errLower.includes('client-token') || errLower.includes('client_token')) {
          lastError = 'Z-API exige Client-Token. Configure em Integrações → Z-API → Token da conta (painel Z-API → Segurança).'
        } else if (errLower.includes('restore') || errLower.includes('disconnected') || errLower.includes('qr') || errLower.includes('qrcode')) {
          lastError = 'WhatsApp desconectado. Escaneie o QR Code novamente no painel de integrações.'
        } else if (bodyText && bodyText.length < 300) {
          try {
            const parsed = JSON.parse(bodyText)
            lastError = parsed?.error || parsed?.message || parsed?.messageError || bodyText
          } catch {
            lastError = bodyText || `HTTP ${res.status}`
          }
        } else {
          lastError = `Falha ao enviar (HTTP ${res.status}). Verifique se a instância está conectada.`
        }
        console.warn('❌ Z-API falha ao enviar texto:', String(num || '').slice(-12), res.status, String(bodyText || '').slice(0, 200))
        continue
      }

      // às vezes a API retorna 200 com "error"
      let data = null
      try { data = bodyText ? JSON.parse(bodyText) : null } catch { data = null }
      const err = data?.error || data?.messageError || data?.errorMessage || null
      if (err) {
        const errStr = String(err)
        lastError = errStr
        if (errStr.toLowerCase().includes('client-token')) {
          lastError = 'Z-API exige Client-Token. Configure em Integrações → Z-API → Token da conta.'
        } else if (errStr.toLowerCase().includes('restore') || errStr.toLowerCase().includes('disconnected')) {
          lastError = 'WhatsApp desconectado. Escaneie o QR Code novamente no painel de integrações.'
        }
        console.warn('❌ Z-API envio retornou erro (200):', String(num || '').slice(-12), errStr.slice(0, 200))
        continue
      }

      const msgId = data?.messageId || data?.zaapId || null
      console.log('✅ Z-API mensagem enviada:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '', replyMessageId ? `[reply a ${String(replyMessageId).slice(0, 10)}...]` : '')
      return { ok: true, messageId: msgId ? String(msgId) : null }
    }
    return { ok: false, messageId: null, error: lastError || 'Falha ao enviar mensagem. Tente novamente.' }
  } catch (e) {
    console.error('❌ Erro Z-API sendText:', e.message)
    const msg = e?.message || String(e)
    let userError = 'Erro de conexão com Z-API. Tente novamente.'
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      userError = 'Não foi possível conectar à Z-API. Verifique sua internet e se a Z-API está online.'
    }
    return { ok: false, messageId: null, error: userError }
  }
}

/**
 * Envia link enriquecido (preview) usando /send-link.
 * @param {string} phone - Número/JID do chat
 * @param {object} payload - message, linkUrl, title, linkDescription
 * @param {{ companyId?: number }} [opts]
 */
async function sendLink(phone, payload, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendLink bloqueado por proteção:', protecao.reason || 'proteção')
    return { ok: false, messageId: null, blockedBy: protecao.reason }
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const nums = await phoneCandidatesForSendAsync(phone, cfg)

  const message = String(payload?.message || '').trim()
  const image = payload?.image != null ? String(payload.image).trim() : ''
  const linkUrl = String(payload?.linkUrl || '').trim()
  const title = String(payload?.title || '').trim()
  const linkDescription = String(payload?.linkDescription || '').trim()

  if (!nums.length || !message || !linkUrl || !title || !linkDescription) {
    return { ok: false, messageId: null }
  }

  try {
    for (const num of nums) {
      const body = {
        phone: num,
        message,
        image,
        linkUrl,
        title,
        linkDescription,
      }
      if (!image) delete body.image

      const res = await fetchWithRetry(`${cfg.basePath}/send-link`, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(body),
      })

      const bodyText = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(bodyText)
        console.warn('❌ Z-API send-link falhou:', String(num || '').slice(-12), res.status, String(bodyText || '').slice(0, 200))
        continue
      }

      let data = null
      try { data = bodyText ? JSON.parse(bodyText) : null } catch { data = null }
      const err = data?.error || data?.messageError || data?.errorMessage || null
      if (err) {
        console.warn('❌ Z-API send-link retornou erro (200):', String(num || '').slice(-12), String(err).slice(0, 200))
        continue
      }

      const msgId = data?.messageId || data?.zaapId || null
      console.log('✅ Z-API link enviado:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
      return { ok: true, messageId: msgId ? String(msgId) : null }
    }
    return { ok: false, messageId: null }
  } catch (e) {
    console.error('❌ Erro Z-API sendLink:', e.message)
    return { ok: false, messageId: null }
  }
}

/**
 * Envia imagem por URL.
 * @param {string} phone - Número (apenas dígitos)
 * @param {string} url - URL pública da imagem
 * @param {string} [caption] - Legenda opcional
 * @param {{ companyId?: number }} [opts]
 */
async function sendImage(phone, url, caption = '', opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendImage bloqueado por proteção:', protecao.reason || 'proteção')
    return false
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    if (!nums.length || !url) return false
    const safeUrl = String(url).trim()
    const safeCaption = caption ? String(caption).trim() : ''
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
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
 * @param {string} phone - Número
 * @param {string} audioUrl - URL pública do áudio
 * @param {{ companyId?: number }} [opts]
 */
async function sendAudio(phone, audioUrl, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendAudio bloqueado por proteção:', protecao.reason || 'proteção')
    return false
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const a = String(audioUrl || '').trim()
    if (!nums.length || !a) return false
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
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
 * @param {string} phone - Número
 * @param {string} url - URL pública do arquivo
 * @param {string} [fileName] - Nome do arquivo
 * @param {{ companyId?: number }} [opts]
 */
async function sendFile(phone, url, fileName = '', opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendFile bloqueado por proteção:', protecao.reason || 'proteção')
    return false
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const nums = await phoneCandidatesForSendAsync(phone, cfg)
  if (!nums.length || !url) return false
  const ext = fileName ? String(fileName).split('.').pop() : 'pdf'
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'pdf'
  try {
    const safeUrl = String(url).trim()
    const safeName = fileName ? String(fileName).trim() : ''
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
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
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendSticker bloqueado por proteção:', protecao.reason || 'proteção')
    return false
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const s = String(sticker || '').trim()
    if (!nums.length || !s) return false
    const author = opts?.stickerAuthor ? String(opts.stickerAuthor).trim() : ''
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
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
 * A Z-API retorna array direto ou pode vir encapsulado (contacts/data/value).
 * @param {number} [page]
 * @param {number} [pageSize]
 * @param {{ companyId?: number }} [opts]
 */
async function getContacts(page = 1, pageSize = 100, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (circuitBreaker.isOpen(companyId)) return []
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const res = await fetch(
      `${cfg.basePath}/contacts?page=${Number(page)}&pageSize=${Number(pageSize)}`,
      { method: 'GET', headers: cfg.headers }
    )
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      if (res.status >= 500 || res.status === 429) circuitBreaker.recordFailure(companyId)
      console.warn('[Z-API] getContacts falhou:', res.status, String(errBody || '').slice(0, 150))
      return []
    }
    circuitBreaker.recordSuccess(companyId)
    const data = await res.json().catch(() => null)
    // Resposta pode ser array direto ou { contacts: [...] } / { data: [...] } / { value: [...] }
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.contacts ?? data.data ?? data.value ?? data.list ?? []
      return Array.isArray(arr) ? arr : []
    }
    return []
  } catch (e) {
    circuitBreaker.recordFailure(companyId)
    console.error('Z-API getContacts:', e.message)
    return []
  }
}

/**
 * Busca URL da foto de perfil de um número.
 * @param {string} phone - Telefone
 * @param {{ companyId?: number }} [opts]
 */
async function getProfilePicture(phone, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (circuitBreaker.isOpen(companyId)) return null
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return null
    for (const num of nums) {
      const res = await fetch(
        `${cfg.basePath}/profile-picture?phone=${encodeURIComponent(num)}`,
        { method: 'GET', headers: cfg.headers }
      )
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        logClientTokenHint(errBody)
        // 400 "You need to be connected" → instância ainda não pronta; permite abortar batch no caller
        if (res.status === 400 && String(errBody || '').toLowerCase().includes('you need to be connected')) {
          circuitBreaker.recordFailure(companyId)
          const err = new Error('ZAPI_NOT_CONNECTED')
          err.code = 'ZAPI_NOT_CONNECTED'
          err.originalBody = errBody
          throw err
        }
        if (res.status >= 500 || res.status === 429) circuitBreaker.recordFailure(companyId)
        console.warn('❌ Z-API getProfilePicture falhou:', num?.slice(-6), res.status, String(errBody || '').slice(0, 200))
        continue
      }
      circuitBreaker.recordSuccess(companyId)
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
    circuitBreaker.recordFailure(companyId)
    console.error('Z-API getProfilePicture:', e.message)
    return null
  }
}

/**
 * Metadados do contato (nome, foto, etc.) — GET /contacts/{phone}
 * @param {string} phone - Telefone
 * @param {{ companyId?: number }} [opts]
 */
async function getContactMetadata(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return null
    for (const num of nums) {
      const res = await fetch(`${cfg.basePath}/contacts/${encodeURIComponent(num)}`, {
        method: 'GET',
        headers: cfg.headers
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
async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendVideo bloqueado por proteção:', protecao.reason || 'proteção')
    return false
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const v = String(videoUrl || '').trim()
    if (!nums.length || !v) return false
    const safeCaption = caption ? String(caption).trim() : ''
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
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
 * Envia reação a uma mensagem existente no chat.
 * POST /send-reaction
 * @param {string} phone - Número/JID do chat
 * @param {string} messageId - ID da mensagem que receberá a reação (whatsapp_id)
 * @param {string} reaction - Emoji de reação (❤️, 👍, etc.)
 * @returns {Promise<boolean>}
 */
async function sendReaction(phone, messageId, reaction, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const mid = String(messageId || '').trim()
    const emoji = String(reaction || '').trim()
    if (!nums.length || !mid || !emoji) return false
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
      endpoint: '/send-reaction',
      phoneCandidates: nums,
      okLogLabel: 'reação',
      buildBody: (num) => ({ phone: num, messageId: mid, reaction: emoji }),
    })
  } catch (e) {
    console.error('❌ Erro Z-API sendReaction:', e.message)
    return false
  }
}

/**
 * Remove reação de uma mensagem existente no chat.
 * POST /send-remove-reaction
 * @param {string} phone - Número/JID do chat
 * @param {string} messageId - ID da mensagem que terá a reação removida (whatsapp_id)
 * @returns {Promise<boolean>}
 */
async function removeReaction(phone, messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const mid = String(messageId || '').trim()
    if (!nums.length || !mid) return false
    return await postJsonWithCandidates({
      basePath: cfg.basePath,
      headers: cfg.headers,
      endpoint: '/send-remove-reaction',
      phoneCandidates: nums,
      okLogLabel: 'remover reação',
      buildBody: (num) => ({ phone: num, messageId: mid }),
    })
  } catch (e) {
    console.error('❌ Erro Z-API removeReaction:', e.message)
    return false
  }
}

/**
 * Compartilha um contato existente em um chat.
 * POST /send-contact
 * @param {string} phone - Número/JID do chat de destino
 * @param {string} contactName - Nome do contato a compartilhar
 * @param {string} contactPhone - Telefone do contato (apenas dígitos)
 * @param {{ messageId?: string }} [opts]
 * @returns {Promise<{ ok: boolean, messageId: string|null }>}
 */
async function sendContact(phone, contactName, contactPhone, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendContact bloqueado por proteção:', protecao.reason || 'proteção')
    return { ok: false, messageId: null }
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    const name = String(contactName || '').trim()
    const contact = String(contactPhone || '').replace(/\D/g, '')
    const replyMessageId = opts?.messageId ? String(opts.messageId).trim() : null
    if (!nums.length || !name || !contact) return { ok: false, messageId: null }

    for (const num of nums) {
      const body = {
        phone: num,
        contactName: name,
        contactPhone: contact,
      }
      if (replyMessageId) body.messageId = replyMessageId

      const res = await fetchWithRetry(`${cfg.basePath}/send-contact`, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(body),
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(text)
        console.warn('❌ Z-API send-contact falhou:', String(num || '').slice(-12), res.status, text.slice(0, 200))
        continue
      }
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      const err = data?.error || data?.errorMessage || null
      if (err) {
        console.warn('❌ Z-API send-contact retornou erro (200):', String(num || '').slice(-12), String(err).slice(0, 200))
        continue
      }
      const msgId = data?.messageId || data?.zaapId || null
      console.log('✅ Z-API contato enviado:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
      return { ok: true, messageId: msgId ? String(msgId) : null }
    }
    return { ok: false, messageId: null }
  } catch (e) {
    console.error('❌ Erro Z-API sendContact:', e.message)
    return { ok: false, messageId: null }
  }
}

/**
 * Envia uma "ligação" via Z-API (chamada simulada).
 * POST /send-call
 * @param {string} phone - Telefone do destinatário (apenas dígitos)
 * @param {number} [callDuration] - duração em segundos (5–15) opcional
 * @returns {Promise<{ ok: boolean, messageId: string|null }>}
 */
async function sendCall(phone, callDuration, opts = {}) {
  const protecao = await permitirEnvio({
    company_id: opts?.companyId ?? opts?.company_id,
    conversa_id: opts?.conversaId ?? opts?.conversa_id,
  })
  if (!protecao.allow) {
    console.warn('[ZAPI] sendCall bloqueado por proteção:', protecao.reason || 'proteção')
    return { ok: false, messageId: null }
  }
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  try {
    const nums = await phoneCandidatesForSendAsync(phone, cfg)
    if (!nums.length) return { ok: false, messageId: null }
    const dur = Number(callDuration)
    const safeDur = Number.isFinite(dur) ? Math.max(1, Math.min(15, dur)) : undefined

    for (const num of nums) {
      const body = { phone: num }
      if (safeDur != null) body.callDuration = safeDur

      const res = await fetchWithRetry(`${cfg.basePath}/send-call`, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(body),
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        logClientTokenHint(text)
        console.warn('❌ Z-API send-call falhou:', String(num || '').slice(-12), res.status, text.slice(0, 200))
        continue
      }
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      const err = data?.error || data?.errorMessage || null
      if (err) {
        console.warn('❌ Z-API send-call retornou erro (200):', String(num || '').slice(0, 12), String(err).slice(0, 200))
        continue
      }
      const msgId = data?.messageId || data?.zaapId || null
      console.log('✅ Z-API ligação iniciada:', String(num || '').slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
      return { ok: true, messageId: msgId ? String(msgId) : null }
    }
    return { ok: false, messageId: null }
  } catch (e) {
    console.error('❌ Erro Z-API sendCall:', e.message)
    return { ok: false, messageId: null }
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
async function getChatMessages(phone, amount = 10, lastMessageId = null, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const nums = phoneCandidatesForLookup(phone)
    if (!nums.length) return []
    for (const num of nums) {
      const qs = new URLSearchParams()
      qs.set('amount', String(Math.max(1, Number(amount) || 10)))
      if (lastMessageId) qs.set('lastMessageId', String(lastMessageId))
      const res = await fetch(`${cfg.basePath}/chat-messages/${encodeURIComponent(num)}?${qs.toString()}`, {
        method: 'GET',
        headers: cfg.headers
      })
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        logClientTokenHint(errBody)
        // "Does not work in multi device version" é esperado — WhatsApp linked devices não suportam histórico
        const isMultiDeviceKnown = String(errBody || '').includes('multi device')
        if (!isMultiDeviceKnown) {
          console.warn('❌ Z-API getChatMessages falhou:', num?.slice(-6), res.status, String(errBody || '').slice(0, 200))
        }
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
/**
 * Configura webhooks na instância Z-API. Exige companyId em produção.
 * @param {string} appUrl - APP_URL
 * @param {{ companyId?: number }} [opts]
 */
async function configureWebhooks(appUrl, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !appUrl) return
  const basePath = cfg.basePath
  const headers = cfg.headers
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
      headers,
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
async function updateProfilePicture(imageUrl, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const res = await fetch(`${cfg.basePath}/profile-picture`, {
      method: 'PUT',
      headers: cfg.headers,
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
async function updateProfileName(name, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const res = await fetch(`${cfg.basePath}/profile-name`, {
      method: 'PUT',
      headers: cfg.headers,
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
async function updateProfileDescription(description, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const res = await fetch(`${cfg.basePath}/profile-description`, {
      method: 'PUT',
      headers: cfg.headers,
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

/**
 * Verifica o status de conexão da instância Z-API (WhatsApp conectado ou não).
 * GET /status → { connected: boolean, phone?: string, ... }
 * @returns {Promise<{ connected: boolean, configured: boolean, phone?: string|null }>}
 */
/**
 * @param {{ companyId?: number }} [opts]
 */
async function getConnectionStatus(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { connected: false, configured: false }
  try {
    const res = await fetch(`${cfg.basePath}/status`, {
      method: 'GET',
      headers: cfg.headers,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logClientTokenHint(body)
      return { connected: false, configured: true }
    }
    const data = await res.json().catch(() => null)
    // Z-API retorna: { connected: true/false, phone: "5511...", ... }
    const connected = data?.connected === true ||
      String(data?.status || '').toLowerCase().includes('connected') ||
      String(data?.value || '').toLowerCase().includes('connected')
    const phone = data?.phone || data?.number || null
    return { connected, configured: true, phone, session: data?.session || null }
  } catch (e) {
    console.warn('Z-API getConnectionStatus:', e.message)
    return { connected: false, configured: true, error: e.message }
  }
}

module.exports = {
  sendText,
  sendLink,
  sendImage,
  sendFile,
  sendAudio,
  sendVideo,
   sendReaction,
   removeReaction,
  sendContact,
  sendCall,
  sendSticker,
  getContacts,
  getProfilePicture,
  getContactMetadata,
  getChatMessages,
  configureWebhooks,
  updateProfilePicture,
  updateProfileName,
  updateProfileDescription,
  getConnectionStatus,
  normalizePhone,
  // Em multi-tenant, "configurado" é por empresa (empresa_zapi). Este flag indica provider disponível.
  isConfigured: true
}
