/**
 * Envio Whapi. Texto + mídia (incl. gif/PTV) + reação + contato + localização (fixa e ao vivo).
 * Whapi: JSON + Bearer. Mídia: campo `media` (URL HTTP(S), media id ou data URI).
 * Resposta síncrona CONFIRMADA: { sent: true, message?: { id } }.
 * sendCall: POST /calls/outgoing (chamada de atenção). delete/edit/read estão em ./messages.js.
 */

const { buildSendMeta } = require('../../whatsappSendGuardService')
const { BODY_MAX_LEN, CAPTION_MAX_LEN, FILENAME_MAX_LEN } = require('./constants')
const { normalizeWhapiSendResult } = require('./result')
const { toWhapiRecipient, toWhapiChatId, recipientCandidates } = require('./phones')
const { resolveConfig } = require('./config')
const { post, put, maskToken } = require('./http')
const { updateChannelSettings } = require('./channel')
const { preferredBrSendDigits } = require('../../../helpers/phoneHelper')

function notImplemented(method) {
  return { ok: false, messageId: null, notImplemented: true, httpStatus: 501, error: `whapi.${method} não implementado` }
}

function applyQuoted(body, opts) {
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  if (replyMessageId) body.quoted = replyMessageId
  return body
}

function asMediaResult(normalized, returnDetails) {
  if (!normalized.ok) return returnDetails ? normalized : false
  return returnDetails ? normalized : true
}

async function postMessage({ cfg, endpoint, body, to, kind, opts, extraMeta }) {
  const { ok, status, data, text } = await post({
    token: cfg.token,
    endpoint,
    body,
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    meta: buildSendMeta(kind, to, opts, extraMeta),
  })
  return normalizeWhapiSendResult({ httpOk: ok, status, data, text, fallbackError: data?.message })
}

/**
 * Envia mensagem de texto via Whapi.
 * Retorna { ok, messageId, error, ... } — objeto, como o UltraMSG (nunca boolean).
 */
async function sendText(phone, message, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  }
  const to = toWhapiRecipient(phone)
  if (!to || !message) {
    return { ok: false, messageId: null, error: 'Número inválido ou mensagem vazia.' }
  }
  const msg = String(message).trim()
  if (msg.length > BODY_MAX_LEN) {
    return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }
  }
  const body = applyQuoted({ to, body: msg }, opts)

  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint: '/messages/text', body, to, kind: 'text', opts, extraMeta: { textLength: msg.length },
    })
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }

  if (!normalized.ok) {
    console.warn('❌ Whapi sendText falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
    return normalized
  }
  console.log('✅ Whapi mensagem enviada:', String(to).slice(-13), normalized.messageId ? `id=${String(normalized.messageId).slice(0, 16)}...` : '')
  return normalized
}

/**
 * Link com preview. Texto simples com URL já gera preview automático no WhatsApp;
 * o endpoint /messages/link_preview serve para CARD CUSTOMIZADO (título/mídia próprios).
 * Usa link_preview quando há título; senão manda texto (que já previa). Fallback resiliente a texto.
 */
async function sendLink(phone, payload, opts = {}) {
  const linkUrl = String(payload?.linkUrl || '').trim()
  const title = String(payload?.title || '').trim()
  const desc = String(payload?.linkDescription || '').trim()
  const baseMsg = String(payload?.message || '').trim()
  let body = baseMsg || [title, desc].filter(Boolean).join('\n')
  // O corpo do link_preview PRECISA conter a URL para o WhatsApp montar o card.
  if (linkUrl && !body.includes(linkUrl)) body = [body, linkUrl].filter(Boolean).join('\n').trim()

  // Sem URL ou sem título customizado: texto simples (já gera preview automático).
  if (!linkUrl || !title) {
    return sendText(phone, body || linkUrl, opts)
  }

  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  const to = toWhapiRecipient(phone)
  if (!to || !body) return { ok: false, messageId: null, error: 'Número inválido ou mensagem vazia.' }
  const linkBody = applyQuoted({
    to, body, title,
    ...(payload?.media ? { media: String(payload.media) } : {}),
  }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/link_preview', body: linkBody, to, kind: 'link', opts, extraMeta: { textLength: body.length },
    })
    if (!normalized.ok) {
      // Não perde a mensagem: se o provider recusar o card, envia como texto (que ainda previa a URL).
      console.warn('⚠️ Whapi link_preview falhou, fallback texto:', String(normalized.error).slice(0, 160))
      return sendText(phone, body, opts)
    }
    console.log('✅ Whapi link enviado:', String(to).slice(-13))
    return normalized
  } catch (e) {
    console.warn('⚠️ Whapi link_preview erro, fallback texto:', e?.message || e)
    return sendText(phone, body, opts)
  }
}

async function sendMediaByEndpoint(endpoint, kind, phone, media, extra = {}, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Instância Whapi não configurada' } : false
  const to = toWhapiRecipient(phone)
  const mediaStr = media == null ? '' : String(media).trim()
  if (!to || !mediaStr) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou mídia inválido' } : false
  }
  const body = applyQuoted({ to, media: mediaStr, ...extra }, opts)
  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint, body, to, kind, opts, extraMeta: { textLength: String(extra?.caption || '').length },
    })
  } catch (e) {
    return returnDetails ? { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` } : false
  }
  if (!normalized.ok) {
    console.warn(`❌ Whapi ${kind} falhou:`, String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
  } else {
    console.log(`✅ Whapi ${kind} enviado:`, String(to).slice(-13), normalized.messageId ? `id=${String(normalized.messageId).slice(0, 16)}...` : '')
  }
  return asMediaResult(normalized, returnDetails)
}

async function sendImage(phone, url, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/image', 'image', phone, url, extra, opts)
}

async function sendFile(phone, url, fileName = '', opts = {}) {
  const extra = {}
  const filenameRaw = fileName ? String(fileName).trim() : ''
  if (filenameRaw) extra.filename = filenameRaw.slice(0, FILENAME_MAX_LEN)
  const captionTrim = String(opts?.caption || '').trim().slice(0, CAPTION_MAX_LEN)
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/document', 'file', phone, url, extra, opts)
}

async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/video', 'video', phone, videoUrl, extra, opts)
}

async function sendSticker(phone, sticker, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/sticker', 'sticker', phone, sticker, extra, opts)
}

async function sendAudio(phone, audioUrl, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/audio', 'audio', phone, audioUrl, extra, opts)
}

async function sendVoice(phone, audioUrl, opts = {}) {
  const extra = {}
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/voice', 'voice', phone, audioUrl, extra, opts)
}

async function sendGif(phone, media, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  if (opts?.autoplay === true) extra.autoplay = true
  return sendMediaByEndpoint('/messages/gif', 'gif', phone, media, extra, opts)
}

async function sendShortVideo(phone, media, caption = '', opts = {}) {
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const extra = {}
  if (captionTrim) extra.caption = captionTrim
  if (opts?.mime_type) extra.mime_type = String(opts.mime_type)
  return sendMediaByEndpoint('/messages/short', 'short', phone, media, extra, opts)
}

/**
 * Reação: PUT /messages/{MessageID}/reaction { emoji }.
 * Contrato do chat UltraMSG: retorno boolean (objeto truthy quebraria `if (!ok)`).
 */
async function sendReaction(phone, messageId, reaction, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  const emoji = String(reaction || '').trim()
  if (!mid || !emoji) return false
  const to = toWhapiRecipient(phone)
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/reaction`,
      body: { emoji },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('reaction', to || phone, opts),
    })
    return !!ok
  } catch (e) {
    console.warn('❌ Whapi sendReaction falhou:', e?.message || e)
    return false
  }
}

/** Whapi: emoji em branco remove a reação. */
async function removeReaction(phone, messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  if (!mid) return false
  const to = toWhapiRecipient(phone)
  try {
    const { ok } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/reaction`,
      body: { emoji: '' },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('reaction', to || phone, opts),
    })
    return !!ok
  } catch (e) {
    console.warn('❌ Whapi removeReaction falhou:', e?.message || e)
    return false
  }
}

async function sendLocation(phone, loc = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const to = toWhapiRecipient(phone)
  const latitude = Number(loc.latitude ?? loc.lat)
  const longitude = Number(loc.longitude ?? loc.lng)
  if (!to || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, messageId: null, error: 'Destino ou coordenadas inválidos' }
  }
  const body = applyQuoted({
    to,
    latitude,
    longitude,
    ...(loc.address || loc.name ? {
      address: String(loc.address || '').slice(0, 300),
      name: String(loc.name || '').slice(0, 120),
    } : {}),
  }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/location', body, to, kind: 'location', opts,
    })
    if (!normalized.ok) return { ...normalized, ok: false }
    console.log('✅ Whapi localização enviada:', String(to).slice(-13))
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }
}

async function sendLiveLocation(phone, loc = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const to = toWhapiRecipient(phone)
  const latitude = Number(loc.latitude ?? loc.lat)
  const longitude = Number(loc.longitude ?? loc.lng)
  if (!to || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, messageId: null, error: 'Destino ou coordenadas inválidos' }
  }
  const body = applyQuoted({
    to,
    latitude,
    longitude,
    ...(loc.address ? { address: String(loc.address).slice(0, 300) } : {}),
    ...(loc.name ? { name: String(loc.name).slice(0, 120) } : {}),
    ...(loc.url ? { url: String(loc.url).slice(0, 500) } : {}),
    ...(Number.isFinite(Number(loc.accuracy)) ? { accuracy: Number(loc.accuracy) } : {}),
    ...(Number.isFinite(Number(loc.speed)) ? { speed: Number(loc.speed) } : {}),
    ...(Number.isFinite(Number(loc.degrees)) ? { degrees: Number(loc.degrees) } : {}),
    ...(loc.comment ? { comment: String(loc.comment).slice(0, 300) } : {}),
  }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/live_location', body, to, kind: 'live_location', opts,
    })
    if (!normalized.ok) return { ...normalized, ok: false }
    console.log('✅ Whapi live location enviada:', String(to).slice(-13))
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }
}

async function sendContact(phone, contactName, contactPhone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const to = toWhapiRecipient(phone)
  const name = String(contactName || '').trim()
  const contact = String(contactPhone || '').replace(/\D/g, '')
  if (!to || !name || !contact) return { ok: false, messageId: null, error: 'Destino ou contato inválido' }
  const tel = contact.startsWith('55') ? contact : `55${contact}`
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${name};;;\nFN:${name}\nTEL;TYPE=CELL;waid=${tel}:+${tel}\nEND:VCARD`
  const body = applyQuoted({ to, name, vcard }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/contact', body, to, kind: 'contact', opts,
    })
    if (!normalized.ok) return { ...normalized, ok: false }
    console.log('✅ Whapi contato enviado:', String(to).slice(-13))
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar (Whapi): ${e?.message || e}` }
  }
}

/**
 * Destino de ligação: Chat ID privado (`…@s.whatsapp.net` / `@lid`) ou JID de grupo.
 * OpenAPI makeCall: `to` é telefone ou chat ID privado.
 */
function toCallRecipient(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('lid:')) {
    const id = raw.slice(4).trim()
    if (!id) return ''
    return id.includes('@') ? id : `${id}@lid`
  }
  if (lower.includes('@lid') || lower.endsWith('@g.us')) return raw
  return toWhapiChatId(raw)
}

/** Dígitos primeiro (9º dígito BR se faltar, igual intenção do sendText); depois JID. LID/grupo: só o JID. */
function callRecipientCandidates(phone) {
  const out = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  const raw = String(phone || '').trim()
  if (!raw) return out
  const lower = raw.toLowerCase()
  if (lower.startsWith('lid:') || lower.includes('@lid') || lower.endsWith('@g.us')) {
    push(toCallRecipient(raw))
    return out
  }
  const digits = []
  const pushDigit = (v) => {
    const d = String(v || '').replace(/\D/g, '')
    if (d && !digits.includes(d)) digits.push(d)
  }
  try {
    const pref = preferredBrSendDigits(raw)
    if (pref) pushDigit(pref)
  } catch { /* ignore */ }
  for (const d of recipientCandidates(raw)) pushDigit(d)
  for (const d of digits) {
    push(d)
    push(`${d}@s.whatsapp.net`)
  }
  if (!out.length) push(toCallRecipient(raw))
  return out
}

function normalizeCallResult({ ok, httpOk, status, data, text }) {
  const accepted = httpOk === true || ok === true
  const callId = data && typeof data === 'object' && data.call_id != null
    ? String(data.call_id).trim()
    : ''
  if (accepted && callId) {
    return {
      ok: true,
      messageId: callId,
      callId,
      duration: data.duration ?? null,
      httpStatus: status ?? null,
      error: null,
    }
  }
  const err = data && typeof data === 'object'
    ? (data.error?.message || data.error || data.message || null)
    : null
  return {
    ok: false,
    messageId: callId || null,
    httpStatus: status ?? null,
    error: String(err || text || `HTTP ${status || 'erro'} ao ligar`).slice(0, 500),
  }
}

/**
 * Chamada de atenção Whapi (POST /calls/outgoing).
 * Toca o WhatsApp do cliente por `duration` segundos (0–30, padrão 15).
 * Não abre VoIP no CRM — a conversa de voz é no telefone (`tel:`).
 * Liga `outgoing_calls_enabled` e tenta dígitos + JID se 400/404/502/503.
 */
async function sendCall(phone, callDuration, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  }
  const candidates = callRecipientCandidates(phone)
  if (!candidates.length) {
    return { ok: false, messageId: null, error: 'Destino inválido para ligação.' }
  }
  const dur = Number(callDuration)
  const duration = Number.isFinite(dur) ? Math.max(0, Math.min(30, Math.round(dur))) : 15

  const postCall = (to) => post({
    token: cfg.token,
    endpoint: '/calls/outgoing',
    body: { to, duration },
    companyId: cfg.companyId,
    whatsappInstanceId: cfg.whatsappInstanceId,
    meta: buildSendMeta('call', to, opts, { duration }),
  })

  try {
    await updateChannelSettings({ outgoing_calls_enabled: true }, opts)
  } catch (_) { /* segue mesmo se o PATCH falhar */ }

  let last = { ok: false, messageId: null, error: 'Não foi possível ligar.' }
  try {
    for (const to of candidates) {
      let res = await postCall(to)
      if (res.status === 503) {
        const enabled = await updateChannelSettings({ outgoing_calls_enabled: true }, opts)
        if (enabled?.ok) res = await postCall(to)
      }
      last = normalizeCallResult(res)
      if (last.ok) {
        console.log('✅ Whapi chamada enviada:', String(to).slice(-18), last.callId ? `id=${String(last.callId).slice(0, 16)}` : '')
        return last
      }
      const st = Number(res.status)
      if (st === 401 || st === 402 || st === 409) {
        console.warn('❌ Whapi sendCall falhou:', String(to).slice(-18), String(last.error).slice(0, 200), '| token:', maskToken(cfg.token))
        return last
      }
    }
    console.warn('❌ Whapi sendCall falhou:', String(candidates[0]).slice(-18), String(last.error).slice(0, 200), '| token:', maskToken(cfg.token))
    return last
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao ligar (Whapi): ${e?.message || e}` }
  }
}

/**
 * Encaminha uma mensagem existente para outro chat.
 * POST /messages/{MessageID} { to, force? } → { sent, message.id } (contrato de envio).
 * Retorna { ok, messageId, error } como sendText (é um novo envio no destino).
 */
async function forwardMessage(phone, messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  }
  const to = toWhapiRecipient(phone)
  const mid = String(messageId || '').trim()
  if (!to || !mid) {
    return { ok: false, messageId: null, error: 'Destino ou id da mensagem inválido.' }
  }
  const body = { to, ...(opts?.force === true ? { force: true } : {}) }
  try {
    const normalized = await postMessage({
      cfg, endpoint: `/messages/${encodeURIComponent(mid)}`, body, to, kind: 'forward', opts, extraMeta: { forwardId: mid },
    })
    if (!normalized.ok) {
      console.warn('❌ Whapi forwardMessage falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
      return normalized
    }
    console.log('✅ Whapi mensagem encaminhada:', String(to).slice(-13), normalized.messageId ? `id=${String(normalized.messageId).slice(0, 16)}...` : '')
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao encaminhar (Whapi): ${e?.message || e}` }
  }
}

const INTERACTIVE_TYPES = new Set(['button', 'list', 'product'])

/** Normaliza header/body/footer que podem vir como string ou { text }. Trim consistente; vazio → undefined. */
function asTextObj(v) {
  if (v == null) return undefined
  const s = typeof v === 'object' ? (v.text != null ? String(v.text) : '') : String(v)
  const t = s.trim()
  return t ? { text: t } : undefined
}

/** Valida que o `action` bate com o `type` (evita chamada de API confusa). */
function interactiveActionMatchesType(type, action) {
  if (!action || typeof action !== 'object') return false
  if (type === 'button') return Array.isArray(action.buttons) && action.buttons.length > 0
  if (type === 'list') return !!action.list && typeof action.list === 'object'
  if (type === 'product') return !!action.product && typeof action.product === 'object'
  return false
}

/**
 * Envia mensagem interativa (botões / lista / produto). POST /messages/interactive.
 * payload: { type:'button'|'list'|'product', body, header?, footer?, action }
 *   - body/header/footer: string ou { text }
 *   - action: estrutura conforme o type (button → { buttons:[...] }; list → { list:{ sections, label } })
 * Retorna { ok, messageId, error } — objeto (como sendText). Contrato: doc 25 §26.3.
 * ATENÇÃO: a funcionalidade de botões no WhatsApp é instável do lado do provedor.
 */
async function sendInteractive(phone, payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  const to = toWhapiRecipient(phone)
  if (!to) return { ok: false, messageId: null, error: 'Número inválido.' }

  const type = String(payload?.type || '').trim().toLowerCase()
  if (!INTERACTIVE_TYPES.has(type)) {
    return { ok: false, messageId: null, error: `type interativo inválido: use ${[...INTERACTIVE_TYPES].join('|')}` }
  }
  const bodyText = asTextObj(payload?.body)
  if (!bodyText) return { ok: false, messageId: null, error: 'body.text é obrigatório na mensagem interativa.' }
  let action = payload?.action
  if (!action || typeof action !== 'object') return { ok: false, messageId: null, error: 'action é obrigatório na mensagem interativa.' }
  if (!interactiveActionMatchesType(type, action)) {
    return { ok: false, messageId: null, error: `action inválido para type='${type}' (button→buttons[]; list→list; product→product).` }
  }

  if (type === 'list') {
    const label = String(action.list.label ?? action.label ?? '').trim()
    if (!label) return { ok: false, messageId: null, error: 'action.list.label é obrigatório na lista.' }
    // Compatibilidade com chamadores antigos; a API exige o label dentro de list.
    const { label: legacyLabel, ...rest } = action
    action = { ...rest, list: { ...action.list, label } }
  }

  const reqBody = applyQuoted({
    to,
    type,
    body: bodyText,
    ...(asTextObj(payload?.header) ? { header: asTextObj(payload.header) } : {}),
    ...(asTextObj(payload?.footer) ? { footer: asTextObj(payload.footer) } : {}),
    action,
  }, opts)

  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint: '/messages/interactive', body: reqBody, to, kind: 'interactive', opts, extraMeta: { interactiveType: type },
    })
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar interativa (Whapi): ${e?.message || e}` }
  }
  if (!normalized.ok) {
    console.warn('❌ Whapi sendInteractive falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
  }
  return normalized
}

const POLL_OPTIONS_MAX = 12

/**
 * Envia enquete (poll). POST /messages/poll { to, title, options[], count }.
 * A Whapi recomenda polls como alternativa ESTÁVEL aos botões (interactive é instável).
 * payload: { title, options: string[], count? }  — count 1 = escolha única (default), 0 = múltipla.
 * Retorna { ok, messageId, error } (objeto, como sendText). Ver doc 25 §29.
 */
async function sendPoll(phone, payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  const to = toWhapiRecipient(phone)
  if (!to) return { ok: false, messageId: null, error: 'Número inválido.' }

  const title = String(payload?.title ?? '').trim()
  if (!title) return { ok: false, messageId: null, error: 'title da enquete é obrigatório.' }

  const options = Array.isArray(payload?.options)
    ? payload.options.map((o) => String(o ?? '').trim()).filter(Boolean)
    : []
  const uniqueOptions = [...new Set(options)].slice(0, POLL_OPTIONS_MAX)
  if (uniqueOptions.length < 2) {
    return { ok: false, messageId: null, error: 'enquete exige ao menos 2 opções distintas.' }
  }

  // count: 1 = escolha única (default p/ triagem), 0 = múltipla escolha.
  const count = payload?.count === 0 || payload?.count === '0' ? 0 : 1

  const reqBody = applyQuoted({ to, title, options: uniqueOptions, count }, opts)
  let normalized
  try {
    normalized = await postMessage({
      cfg, endpoint: '/messages/poll', body: reqBody, to, kind: 'poll', opts, extraMeta: { options: uniqueOptions.length },
    })
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar enquete (Whapi): ${e?.message || e}` }
  }
  if (!normalized.ok) {
    console.warn('❌ Whapi sendPoll falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
  }
  return normalized
}

/**
 * Envia um quiz (enquete com resposta correta). POST /messages/quiz
 * { to, title, options[], correct_option_index }. Pesquisa "gamificada" p/ triagem/disparo.
 * payload: { title, options: string[], correctOptionIndex, hideParticipantName?, allowAddOption? }.
 * Retorna { ok, messageId, error }. Contrato via MCP sendMessageQuiz + OpenAPI. Ver doc 25 §32.
 */
async function sendQuiz(phone, payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  const to = toWhapiRecipient(phone)
  if (!to) return { ok: false, messageId: null, error: 'Número inválido.' }

  const title = String(payload?.title ?? '').trim()
  if (!title) return { ok: false, messageId: null, error: 'title do quiz é obrigatório.' }

  const options = Array.isArray(payload?.options)
    ? payload.options.map((o) => String(o ?? '').trim()).filter(Boolean)
    : []
  const uniqueOptions = [...new Set(options)].slice(0, POLL_OPTIONS_MAX)
  if (uniqueOptions.length < 2) {
    return { ok: false, messageId: null, error: 'quiz exige ao menos 2 opções distintas.' }
  }

  const idx = Number(payload?.correctOptionIndex ?? payload?.correct_option_index)
  if (!Number.isInteger(idx) || idx < 0 || idx >= uniqueOptions.length) {
    return { ok: false, messageId: null, error: 'correctOptionIndex deve apontar para uma das opções (0-based).' }
  }

  const reqBody = applyQuoted({ to, title, options: uniqueOptions, correct_option_index: idx }, opts)
  if (payload?.hideParticipantName === true) reqBody.hide_participant_name = true
  if (payload?.allowAddOption === true) reqBody.allow_add_option = true

  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/quiz', body: reqBody, to, kind: 'quiz', opts, extraMeta: { options: uniqueOptions.length },
    })
    if (!normalized.ok) {
      console.warn('❌ Whapi sendQuiz falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
    }
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar quiz (Whapi): ${e?.message || e}` }
  }
}

/**
 * Envia uma pergunta aberta (resposta livre). POST /messages/question { to, body }.
 * Retorna { ok, messageId, error }. Contrato via MCP sendMessageQuestion + OpenAPI. Ver doc 25 §32.
 */
async function sendQuestion(phone, question, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  const to = toWhapiRecipient(phone)
  if (!to) return { ok: false, messageId: null, error: 'Número inválido.' }
  const bodyText = String(question ?? '').trim()
  if (!bodyText) return { ok: false, messageId: null, error: 'body da pergunta é obrigatório.' }
  if (bodyText.length > BODY_MAX_LEN) return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }

  const reqBody = applyQuoted({ to, body: bodyText }, opts)
  try {
    const normalized = await postMessage({
      cfg, endpoint: '/messages/question', body: reqBody, to, kind: 'question', opts, extraMeta: { textLength: bodyText.length },
    })
    if (!normalized.ok) {
      console.warn('❌ Whapi sendQuestion falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
    }
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao enviar pergunta (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  sendText,
  sendLink,
  sendInteractive,
  sendPoll,
  sendQuiz,
  sendQuestion,
  sendImage,
  sendFile,
  sendVideo,
  sendSticker,
  sendAudio,
  sendVoice,
  sendGif,
  sendShortVideo,
  sendPtv: sendShortVideo,
  sendContact,
  sendLocation,
  sendLiveLocation,
  sendReaction,
  removeReaction,
  sendCall,
  forwardMessage,
  notImplemented,
}
