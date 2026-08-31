const { buildSendMeta } = require('../../whatsappSendGuardService')
const { BODY_MAX_LEN, CAPTION_MAX_LEN, FILENAME_MAX_LEN } = require('./constants')
const { ultramsgResponseIndicatesBadInstanceToken, normalizeUltraMsgSendResult } = require('./result')
const { phoneCandidatesForSend } = require('./phones')
const { awaitSendDelay } = require('./delay')
const { resolveConfig } = require('./config')
const { postJson, getJson, aplicarReferenceId, maskToken } = require('./http')
const { isFileExtensionError } = require('./audio')

/**
 * Envia mensagem de texto.
 */
async function sendText(phone, message, opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  await awaitSendDelay(companyId, opts)
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância UltraMsg não configurada. Conecte o WhatsApp no painel de integrações.' }
  }
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !message) {
    return { ok: false, messageId: null, error: 'Número inválido ou mensagem vazia.' }
  }
  const msg = String(message).trim()
  if (msg.length > BODY_MAX_LEN) {
    return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }
  }
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  const body = aplicarReferenceId({ to: nums[0], body: msg }, opts)
  if (replyMessageId) body.msgId = replyMessageId

  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/chat',
    body,
    meta: buildSendMeta('text', nums[0], opts, { textLength: msg.length }),
  })
  // UltraMsg retorna HTTP 200 mesmo em caso de erro (ex.: token inválido) — checar body também
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  const bodyError = !normalized.ok
  if (!ok || bodyError) {
    let errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    if (ultramsgResponseIndicatesBadInstanceToken(data, text)) {
      errMsg += ` — Atualize instance_token em empresa_zapi (token atual do painel UltraMSG, company_id=${cfg.companyId}).`
    }
    console.warn('❌ UltraMsg sendText falhou:', nums[0]?.slice(-12), status, errMsg.slice(0, 200), '| token:', maskToken(cfg.token))
    return { ...normalized, ok: false, error: errMsg }
  }
  const msgId = normalized.messageId
  const numLog = nums[0] ? (String(nums[0]).replace(/\D/g, '').length >= 13 ? String(nums[0]).slice(-13) : String(nums[0]).slice(-12)) : ''
  console.log('✅ UltraMsg mensagem enviada:', numLog || nums[0], msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return normalized
}

/**
 * Envia link enriquecido (fallback: sendText com URL para preview automático).
 */
async function sendLink(phone, payload, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id, opts)
  const linkUrl = String(payload?.linkUrl || '').trim()
  const title = String(payload?.title || '').trim()
  const desc = String(payload?.linkDescription || '').trim()
  const msg = String(payload?.message || '').trim() || `${title}\n${desc}\n${linkUrl}`
  return sendText(phone, msg, opts)
}

/**
 * Envia imagem por URL.
 */
async function sendImage(phone, url, caption = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL da imagem inválido' } : false
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = aplicarReferenceId({ to: nums[0], image: String(url).trim() }, opts)
  if (captionTrim) body.caption = captionTrim
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/image',
    body,
    meta: buildSendMeta('image', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    console.warn('❌ UltraMsg sendImage falhou:', nums[0]?.slice(-12), String(text || data?.error || '').slice(0, 150), '| token:', maskToken(cfg.token))
    return returnDetails ? normalized : false
  }
  console.log('✅ UltraMsg imagem enviada:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia documento por URL.
 */
async function sendFile(phone, url, fileName = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !url) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL do documento inválido' } : false
  }
  const ext = fileName ? String(fileName).split('.').pop() : 'pdf'
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'pdf'
  const filenameRaw = fileName ? String(fileName).trim() : `file.${safeExt}`
  const filename = filenameRaw.slice(0, FILENAME_MAX_LEN)
  const captionTrim = String(opts?.caption || '').trim().slice(0, CAPTION_MAX_LEN)
  // UltraMsg exige caption no POST /messages/document (vazio falha o envio).
  // Não usar o nome do arquivo como legenda visível no WhatsApp.
  const captionForApi = captionTrim || ' '
  const body = aplicarReferenceId(
    { to: nums[0], document: String(url).trim(), filename, caption: captionForApi },
    opts
  )
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/document',
    body,
    meta: buildSendMeta('file', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    let errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    if (isFileExtensionError(errMsg) || isFileExtensionError(data?.error)) {
      errMsg = `Extensão não suportada pelo WhatsApp (.${safeExt}). Tente ZIP, PDF ou outro formato.`
    }
    console.warn('❌ UltraMsg sendFile falhou:', nums[0]?.slice(-12), filename?.slice(-40), errMsg.slice(0, 200))
    return returnDetails ? { ok: false, messageId: null, error: errMsg } : false
  }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg arquivo enviado:', nums[0]?.slice(-12), filename?.slice(-30))
  return returnDetails ? { ok: true, messageId: msgId ? String(msgId) : null, error: null } : true
}

/**
 * Envia vídeo por URL.
 */
async function sendVideo(phone, videoUrl, caption = '', opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !videoUrl) {
    return returnDetails ? { ok: false, messageId: null, error: 'Destino ou URL do vídeo inválido' } : false
  }
  const captionTrim = String(caption || '').trim().slice(0, CAPTION_MAX_LEN)
  const body = aplicarReferenceId({ to: nums[0], video: String(videoUrl).trim() }, opts)
  if (captionTrim) body.caption = captionTrim
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/video',
    body,
    meta: buildSendMeta('video', nums[0], opts, { textLength: captionTrim.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) {
    const errMsg = String(normalized.error || data?.error || data?.message || text?.slice(0, 200) || `HTTP ${status}`)
    console.warn('❌ UltraMsg sendVideo falhou:', nums[0]?.slice(-12), errMsg.slice(0, 200))
    return returnDetails ? { ok: false, messageId: null, error: errMsg } : false
  }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg vídeo enviado:', nums[0]?.slice(-12), msgId ? `id=${String(msgId).slice(0, 14)}...` : '')
  return returnDetails ? { ok: true, messageId: msgId ? String(msgId) : null, error: null } : true
}

/**
 * Envia figurinha (sticker) por URL.
 */
async function sendSticker(phone, sticker, opts = {}) {
  const returnDetails = opts?.returnDetails === true
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return returnDetails ? { ok: false, messageId: null, error: 'Configuração UltraMsg indisponível' } : false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length || !sticker) return returnDetails ? { ok: false, messageId: null, error: 'Destino ou sticker inválido' } : false
  const body = aplicarReferenceId({ to: nums[0], sticker: String(sticker).trim() }, opts)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/sticker',
    body,
    meta: buildSendMeta('sticker', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return returnDetails ? normalized : false
  console.log('✅ UltraMsg sticker enviado:', nums[0]?.slice(-12))
  return returnDetails ? normalized : true
}

/**
 * Envia reação a uma mensagem.
 * UltraMsg: msgId, emoji. O chat é inferido pelo msgId.
 */
async function sendReaction(phone, messageId, reaction, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  const emoji = String(reaction || '').trim()
  if (!mid || !emoji) return false
  const nums = phoneCandidatesForSend(phone)
  if (!nums.length) return false
  const body = { msgId: mid, emoji }
  const { ok } = await postJson({
    ...cfg,
    endpoint: '/messages/reaction',
    body,
    meta: buildSendMeta('reaction', nums[0], opts),
  })
  return ok
}

/**
 * Remove reação. UltraMsg não tem endpoint dedicado — envia reação vazia se suportado.
 */
async function removeReaction(phone, messageId, opts = {}) {
  return sendReaction(phone, messageId, '', opts)
}

/**
 * Envia localização.
 * POST /{instance_id}/messages/location — body: token, to, address, lat, lng
 * address: até 2 linhas com \n; máx 300 chars
 */
async function sendLocation(phone, { address = '', lat, lng }, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const nums = phoneCandidatesForSend(phone)
  const addr = String(address || '').slice(0, 300)
  const latitude = Number(lat)
  const longitude = Number(lng)
  if (!nums.length || (isNaN(latitude) && isNaN(longitude))) return { ok: false, messageId: null }
  const body = aplicarReferenceId({ to: nums[0], address: addr, lat: latitude, lng: longitude }, opts)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/location',
    body,
    meta: buildSendMeta('location', nums[0], opts, { textLength: addr.length }),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return { ...normalized, ok: false }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg localização enviada:', nums[0]?.slice(-12))
  return normalized
}

/**
 * Deleta mensagem no WhatsApp. msgId deve vir do webhook.
 * POST /{instance_id}/messages/delete — body: token, msgId
 */
async function deleteMessage(phone, msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(msgId || '').trim()
  if (!mid) return false
  const body = { msgId: mid }
  const { ok } = await postJson({ ...cfg, endpoint: '/messages/delete', body })
  return ok
}

/**
 * Reenvia mensagens por status (unsent ou expired).
 * POST /{instance_id}/messages/resendByStatus — body: token, status
 */
async function resendByStatus(status, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const s = String(status || '').toLowerCase()
  if (!['unsent', 'expired'].includes(s)) return { ok: false, error: 'status deve ser unsent ou expired' }
  const body = { status: s }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/resendByStatus', body })
  return { ok, data, text }
}

/**
 * Reenvia mensagem por id.
 * POST /{instance_id}/messages/resendById — body: token, id
 */
async function resendById(msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const mid = String(msgId || '').trim()
  if (!mid) return { ok: false, error: 'msgId obrigatório' }
  const body = { id: mid }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/resendById', body })
  return { ok, data, text }
}

/**
 * Limpa mensagens por status (queue, sent, unsent, invalid).
 * POST /{instance_id}/messages/clear — body: token, status
 */
async function clearMessages(status, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false }
  const s = String(status || '').toLowerCase()
  if (!['queue', 'sent', 'unsent', 'invalid'].includes(s)) return { ok: false, error: 'status inválido' }
  const body = { status: s }
  const { ok, data, text } = await postJson({ ...cfg, endpoint: '/messages/clear', body })
  return { ok, data, text }
}

/**
 * Estatísticas de mensagens (sent, queue, unsent).
 * GET /{instance_id}/messages/statistics
 */
async function getMessagesStatistics(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return null
  const { ok, data } = await getJson({ ...cfg, endpoint: '/messages/statistics' })
  if (!ok) return null
  return data
}

/**
 * Lista mensagens enviadas via API UltraMsg.
 * GET /{instance_id}/messages — page, limit (máx 100), status (all|queue|sent|unsent|invalid|expired), sort (asc|desc)
 */
async function getMessages(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, data: [], error: 'Instância não configurada' }
  const page = Math.max(1, Number(opts.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 100))
  const status = String(opts.status || 'all').toLowerCase()
  const sort = ['asc', 'desc'].includes(String(opts.sort || '').toLowerCase()) ? opts.sort : 'desc'
  const validStatus = ['all', 'queue', 'sent', 'unsent', 'invalid', 'expired']
  const extraParams = { page: String(page), limit: String(limit), sort }
  if (validStatus.includes(status) && status !== 'all') extraParams.status = status
  const referenceId = opts?.referenceId != null ? String(opts.referenceId).trim() : ''
  const providerId = opts?.id != null ? String(opts.id).trim() : ''
  const from = opts?.from != null ? String(opts.from).trim() : ''
  const to = opts?.to != null ? String(opts.to).trim() : ''
  if (referenceId) extraParams.referenceId = referenceId
  if (providerId) extraParams.id = providerId
  if (from) extraParams.from = from
  if (to) extraParams.to = to

  const { ok, data, text } = await getJson({ ...cfg, endpoint: '/messages', extraParams })
  if (!ok) {
    const err = data?.error || data?.message || text?.slice(0, 200) || `HTTP error`
    return { ok: false, data: [], error: err }
  }
  const list = Array.isArray(data) ? data : (data?.messages ?? data?.data ?? [])
  return { ok: true, data: list }
}

/**
 * Compartilha contato via vCard.
 */
async function sendContact(phone, contactName, contactPhone, opts = {}) {
  await awaitSendDelay(opts?.companyId ?? opts?.company_id)
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, messageId: null }
  const nums = phoneCandidatesForSend(phone)
  const name = String(contactName || '').trim()
  const contact = String(contactPhone || '').replace(/\D/g, '')
  if (!nums.length || !name || !contact) return { ok: false, messageId: null }
  const tel = contact.startsWith('55') ? contact : `55${contact}`
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${name};;;\nFN:${name}\nTEL;TYPE=CELL;waid=${tel}:+${tel}\nEND:VCARD`
  const body = aplicarReferenceId({ to: nums[0], vcard }, opts)
  const { ok, status, data, text } = await postJson({
    ...cfg,
    endpoint: '/messages/vcard',
    body,
    meta: buildSendMeta('contact', nums[0], opts),
  })
  const normalized = normalizeUltraMsgSendResult({
    httpOk: ok,
    status,
    data,
    text,
    fallbackError: data?.message,
  })
  if (!normalized.ok) return { ...normalized, ok: false }
  const msgId = normalized.messageId
  console.log('✅ UltraMsg contato enviado:', nums[0]?.slice(-12))
  return normalized
}

/**
 * Envia ligação simulada. UltraMsg não possui endpoint — stub.
 */
async function sendCall(phone, callDuration, opts = {}) {
  console.warn('[ULTRAMSG] sendCall não suportado pela API UltraMsg.')
  return { ok: false, messageId: null }
}

module.exports = {
  sendText,
  sendLink,
  sendImage,
  sendFile,
  sendVideo,
  sendSticker,
  sendReaction,
  removeReaction,
  sendLocation,
  deleteMessage,
  resendByStatus,
  resendById,
  clearMessages,
  getMessagesStatistics,
  getMessages,
  sendContact,
  sendCall,
}
