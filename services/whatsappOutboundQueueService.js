const supabase = require('../config/supabase')
const { getProvider } = require('./providers')

const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number(process.env.WHATSAPP_OUTBOUND_MAX_ATTEMPTS || 5))
const DEFAULT_CLAIM_LIMIT = Math.max(1, Number(process.env.WHATSAPP_OUTBOUND_CLAIM_LIMIT || 10))
const DEFAULT_LOCK_SECONDS = Math.max(30, Number(process.env.WHATSAPP_OUTBOUND_LOCK_SECONDS || 120))
const DEFAULT_INTERVAL_MS = Math.max(250, Number(process.env.WHATSAPP_OUTBOUND_WORKER_INTERVAL_MS || 1000))
const DEFAULT_ACK_WAIT_MS = Math.max(60_000, Number(process.env.WHATSAPP_OUTBOUND_ACK_WAIT_MS || 5 * 60_000))
const DEFAULT_MAX_AGE_MS = Math.max(5 * 60_000, Number(process.env.WHATSAPP_OUTBOUND_MAX_AGE_MS || 24 * 60 * 60_000))
const DEFAULT_MAX_CONCURRENCY = Math.max(1, Number(process.env.ULTRAMSG_MAX_CONCURRENCY || process.env.WHATSAPP_OUTBOUND_MAX_CONCURRENCY || 1))
const DEFAULT_SEND_DELAY_MS = Math.max(0, Number(process.env.ULTRAMSG_SEND_DELAY_MS || process.env.WHATSAPP_OUTBOUND_SEND_DELAY_MS || 0))

function outboundWorkerEnabled() {
  return process.env.WHATSAPP_OUTBOUND_QUEUE_ENABLED !== '0'
}

function isRealWhatsAppId(waId) {
  if (!waId) return false
  const s = String(waId).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
  if (s.includes('@')) return true
  if (/^[A-F0-9]{12,}$/i.test(s)) return true
  return s.length > 20
}

function shortPhone(phone) {
  const s = String(phone || '')
  return s.length > 13 ? s.slice(-13) : s.slice(-12)
}

function statusEventName(io) {
  return io?.EVENTS?.STATUS_MENSAGEM || 'status_mensagem'
}

function emitMessageStatus(io, row, status, statusMensagem, extra = {}) {
  if (!io || !row) return
  const payload = {
    mensagem_id: row.id,
    conversa_id: Number(row.conversa_id),
    status,
    status_mensagem: statusMensagem,
    ...extra,
  }
  io.to(`empresa_${row.company_id}`)
    .to(`conversa_${row.conversa_id}`)
    .to(`usuario_${row.autor_usuario_id}`)
    .emit(statusEventName(io), payload)
}

function normalizeProviderResult(result) {
  if (typeof result === 'boolean') {
    return result
      ? { ok: true, messageId: null, httpStatus: null, error: null, rawResponse: null }
      : { ok: false, messageId: null, httpStatus: null, error: 'provider_false', rawResponse: null }
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, messageId: null, httpStatus: null, error: 'provider_empty_response', rawResponse: null }
  }
  return {
    ok: result.ok === true,
    messageId: result.messageId != null ? String(result.messageId).trim() : null,
    httpStatus: result.httpStatus ?? result.status ?? null,
    error: result.error || result.blockedBy || null,
    rawResponse: result.rawResponse ?? result.data ?? result.text ?? null,
  }
}

function classifyFailure({ result, error }) {
  const httpStatus = Number(result?.httpStatus || error?.status || error?.statusCode || 0)
  const message = String(result?.error || error?.message || error || '').toLowerCase()

  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return { temporary: true, code: httpStatus ? String(httpStatus) : 'temporary_http', reason: result?.error || error?.message || `HTTP ${httpStatus}` }
  }
  if (!result && error) {
    return { temporary: true, code: 'network_error', reason: error?.message || String(error) }
  }
  if (message.includes('timeout') || message.includes('abort') || message.includes('econn') || message.includes('network') || message.includes('fetch failed')) {
    return { temporary: true, code: 'network_error', reason: result?.error || error?.message || 'Erro temporario de rede' }
  }
  if (message.includes('empty') || message.includes('sem aceite') || message.includes('provider_empty_response')) {
    return { temporary: true, code: 'empty_response', reason: result?.error || 'Resposta vazia/sem aceite do provedor' }
  }
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404 || httpStatus === 422) {
    return { temporary: false, code: httpStatus ? String(httpStatus) : 'provider_rejected', reason: result?.error || `HTTP ${httpStatus}` }
  }
  if (
    message.includes('numero invalido') ||
    message.includes('número inválido') ||
    message.includes('mensagem vazia') ||
    message.includes('configuracao') ||
    message.includes('configuração') ||
    message.includes('token') ||
    message.includes('instancia') ||
    message.includes('instância') ||
    message.includes('extensao') ||
    message.includes('extensão') ||
    message.includes('url') ||
    message.includes('payload')
  ) {
    return { temporary: false, code: 'provider_rejected', reason: result?.error || error?.message || 'Falha definitiva do provedor' }
  }
  return { temporary: true, code: httpStatus ? String(httpStatus) : 'unknown_provider_error', reason: result?.error || error?.message || 'Falha temporaria/ambigua do provedor' }
}

function computeBackoffMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1)
  const base = 2_000 * Math.pow(2, Math.min(n - 1, 6))
  const jitter = Math.floor(Math.random() * 500)
  return Math.min(base + jitter, 5 * 60_000)
}

function buildQueuePayload({ kind, phone, content = {}, opts = {} }) {
  return {
    version: 1,
    kind,
    phone: phone ? String(phone) : '',
    content,
    opts,
    createdAt: new Date().toISOString(),
  }
}

async function findExistingByClientTempId({ companyId, conversaId, userId, clientTempId }) {
  const tempId = clientTempId && String(clientTempId).trim()
  if (!tempId) return null
  const { data, error } = await supabase
    .from('mensagens')
    .select('*')
    .eq('company_id', Number(companyId))
    .eq('conversa_id', Number(conversaId))
    .eq('autor_usuario_id', Number(userId))
    .eq('client_temp_id', tempId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function enqueueOutboundMessage({ messageId, companyId, payload, clientTempId = null, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  if (!messageId) throw new Error('messageId obrigatorio para enfileirar envio WhatsApp')
  if (!payload || typeof payload !== 'object') throw new Error('send_payload obrigatorio para enfileirar envio WhatsApp')
  const nowIso = new Date().toISOString()
  const update = {
    send_payload: payload,
    send_status: 'queued',
    status: 'pending',
    status_mensagem: 'pending',
    queued_at: nowIso,
    next_attempt_at: nowIso,
    max_tentativas_envio: Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS),
    locked_at: null,
    enviando_ate: null,
    locked_by: null,
    ultimo_erro_envio: null,
    ultimo_codigo_erro: null,
  }
  if (clientTempId) update.client_temp_id = String(clientTempId).trim().slice(0, 64)

  let query = supabase.from('mensagens').update(update).eq('id', messageId)
  if (companyId != null) query = query.eq('company_id', Number(companyId))
  const { data, error } = await query.select().single()
  if (error) throw error
  return data
}

async function resolveDefaultInstanceIdForJob(companyId, whatsappInstanceId) {
  const explicit = Number(whatsappInstanceId)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  try {
    const { getDefaultWhatsappInstance } = require('./whatsappInstanceService')
    const resolved = await getDefaultWhatsappInstance(Number(companyId))
    const id = Number(resolved?.instance?.id)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch (err) {
    console.warn('[OUTBOUND_QUEUE_JOB] default_instance_lookup_failed', {
      company_id: companyId,
      erro: String(err?.message || err).slice(0, 200),
    })
    return null
  }
}

async function markQueuedMessageFailed({ messageId, companyId, error, code = 'enqueue_failed', io = null }) {
  const update = {
    status: 'erro',
    status_mensagem: 'failed',
    send_status: 'failed',
    ultimo_erro_envio: String(error || 'Falha ao enfileirar/enviar mensagem').slice(0, 500),
    ultimo_codigo_erro: String(code || 'failed').slice(0, 80),
    locked_at: null,
    enviando_ate: null,
    locked_by: null,
  }
  let query = supabase.from('mensagens').update(update).eq('id', messageId)
  if (companyId != null) query = query.eq('company_id', Number(companyId))
  const { data, error: dbError } = await query.select().single()
  if (dbError) throw dbError
  emitMessageStatus(io, data, 'erro', 'failed', { erro: update.ultimo_erro_envio })
  return data
}

async function enqueueOutboundJob({
  companyId,
  phone,
  payload,
  conversaId = null,
  whatsappInstanceId = null,
  metadata = {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!companyId) throw new Error('companyId obrigatorio para job outbound WhatsApp')
  if (!phone) throw new Error('destination_phone obrigatorio para job outbound WhatsApp')
  if (!payload || typeof payload !== 'object') throw new Error('send_payload obrigatorio para job outbound WhatsApp')
  const nowIso = new Date().toISOString()
  const resolvedWhatsappInstanceId = await resolveDefaultInstanceIdForJob(companyId, whatsappInstanceId)
  const { data, error } = await supabase
    .from('whatsapp_outbound_jobs')
    .insert({
      company_id: Number(companyId),
      conversa_id: conversaId != null ? Number(conversaId) : null,
      whatsapp_instance_id: resolvedWhatsappInstanceId,
      destination_phone: String(phone),
      kind: payload.kind || 'text',
      send_payload: payload,
      send_status: 'queued',
      tentativas_envio: 0,
      max_tentativas_envio: Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS),
      next_attempt_at: nowIso,
      queued_at: nowIso,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    })
    .select()
    .single()
  if (error) throw error
  return data
}

async function requeueOutboundMessage({ companyId, conversaId, messageId, io = null }) {
  const { data: row, error } = await supabase
    .from('mensagens')
    .select('*')
    .eq('company_id', Number(companyId))
    .eq('conversa_id', Number(conversaId))
    .eq('id', Number(messageId))
    .maybeSingle()
  if (error) throw error
  if (!row) return { ok: false, status: 404, error: 'Mensagem nao encontrada' }
  if (row.whatsapp_id || row.provider_message_id) {
    return { ok: false, status: 409, error: 'Mensagem ja possui ID do provedor/WhatsApp e nao pode ser reenviada' }
  }
  if (!row.send_payload) {
    return { ok: false, status: 400, error: 'Mensagem nao possui payload persistente para reenvio' }
  }
  const allowed = new Set(['failed_retryable', 'expired', 'failed', 'erro'])
  if (!allowed.has(String(row.send_status || row.status || '').toLowerCase())) {
    return { ok: false, status: 409, error: 'Mensagem nao esta em estado de reenvio manual' }
  }
  const nowIso = new Date().toISOString()
  const { data, error: updateError } = await supabase
    .from('mensagens')
    .update({
      status: 'pending',
      status_mensagem: 'pending',
      send_status: 'queued',
      tentativas_envio: 0,
      next_attempt_at: nowIso,
      queued_at: row.queued_at || nowIso,
      locked_at: null,
      enviando_ate: null,
      locked_by: null,
      ultimo_erro_envio: null,
      ultimo_codigo_erro: null,
    })
    .eq('company_id', Number(companyId))
    .eq('conversa_id', Number(conversaId))
    .eq('id', Number(messageId))
    .select()
    .single()
  if (updateError) throw updateError
  emitMessageStatus(io, data, 'pending', 'pending', { send_status: 'queued', em_retry: true, requeued: true })
  console.log('[OUTBOUND_QUEUE] reenvio_manual_enfileirado', {
    company_id: companyId,
    conversa_id: conversaId,
    mensagem_id: messageId,
    whatsapp_instance_id: data?.whatsapp_instance_id || null,
  })
  return { ok: true, message: data }
}

async function claimOutboundMessages({
  workerId,
  limit = DEFAULT_CLAIM_LIMIT,
  lockSeconds = DEFAULT_LOCK_SECONDS,
  maxPerQueue = DEFAULT_MAX_CONCURRENCY,
  sendDelayMs = DEFAULT_SEND_DELAY_MS,
} = {}) {
  const { data, error } = await supabase.rpc('claim_whatsapp_outbound_messages', {
    p_worker_id: workerId || 'worker',
    p_limit: limit,
    p_lock_seconds: lockSeconds,
    p_max_per_queue: Math.max(1, Number(maxPerQueue) || 1),
    p_send_delay_ms: Math.max(0, Number(sendDelayMs) || 0),
  })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function claimOutboundJobs({
  workerId,
  limit = DEFAULT_CLAIM_LIMIT,
  lockSeconds = DEFAULT_LOCK_SECONDS,
  maxPerQueue = DEFAULT_MAX_CONCURRENCY,
  sendDelayMs = DEFAULT_SEND_DELAY_MS,
} = {}) {
  const { data, error } = await supabase.rpc('claim_whatsapp_outbound_jobs', {
    p_worker_id: workerId || 'worker',
    p_limit: limit,
    p_lock_seconds: lockSeconds,
    p_max_per_queue: Math.max(1, Number(maxPerQueue) || 1),
    p_send_delay_ms: Math.max(0, Number(sendDelayMs) || 0),
  })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

function sendOptions(row, payload, extra = {}) {
  return {
    companyId: row.company_id,
    conversaId: row.conversa_id || undefined,
    whatsappInstanceId: row.whatsapp_instance_id || undefined,
    sendOrigin: payload?.opts?.sendOrigin || 'outbound_queue',
    replyMessageId: payload?.opts?.replyMessageId || undefined,
    referenceId: payload?.opts?.referenceId || `crm-${row.id}`,
    returnDetails: true,
    ...extra,
  }
}

async function resolveMediaUrl(provider, row, payload) {
  const content = payload.content || {}
  if (content.mediaUrl) return content.mediaUrl
  const uploadPath = content.uploadFilePath || content.filePath
  if (uploadPath && provider?.uploadMedia) {
    const uploaded = await provider.uploadMedia(uploadPath, content.fileName || 'file', {
      companyId: row.company_id,
      whatsappInstanceId: row.whatsapp_instance_id || undefined,
    })
    if (uploaded?.ok && uploaded?.url) return uploaded.url
    if (content.fallbackMediaUrl) return content.fallbackMediaUrl
    const normalized = normalizeProviderResult(uploaded)
    throw Object.assign(new Error(normalized.error || 'Upload de midia falhou'), { providerResult: normalized })
  }
  if (content.fallbackMediaUrl) return content.fallbackMediaUrl
  throw new Error('URL de midia indisponivel para envio')
}

async function dispatchToProvider(row) {
  if (row.whatsapp_id || row.provider_message_id) {
    return { skipped: true, reason: 'message_already_has_provider_id' }
  }
  const payload = row.send_payload || {}
  const provider = getProvider()
  if (!provider) return { ok: false, error: 'Provider WhatsApp nao configurado' }
  const phone = payload.phone
  const content = payload.content || {}

  switch (payload.kind) {
    case 'link':
      if (provider.sendLink) {
        return provider.sendLink(phone, content.link || {}, sendOptions(row, payload))
      }
      return provider.sendText(phone, content.text || content.link?.message || '', sendOptions(row, payload))
    case 'text':
      return provider.sendText(phone, content.text || '', sendOptions(row, payload))
    case 'image': {
      const url = await resolveMediaUrl(provider, row, payload)
      return provider.sendImage(phone, url, content.caption || '', sendOptions(row, payload))
    }
    case 'video': {
      const url = await resolveMediaUrl(provider, row, payload)
      return provider.sendVideo(phone, url, content.caption || '', sendOptions(row, payload))
    }
    case 'audio': {
      const url = await resolveMediaUrl(provider, row, payload)
      return provider.sendAudio(phone, url, sendOptions(row, payload, { audioMeta: content.audioMeta || undefined }))
    }
    case 'voice': {
      const url = await resolveMediaUrl(provider, row, payload)
      if (provider.sendVoice) return provider.sendVoice(phone, url, sendOptions(row, payload, { audioMeta: content.audioMeta || undefined }))
      return provider.sendAudio(phone, url, sendOptions(row, payload, { audioMeta: content.audioMeta || undefined }))
    }
    case 'sticker': {
      const url = await resolveMediaUrl(provider, row, payload)
      return provider.sendSticker(phone, url, sendOptions(row, payload, { stickerAuthor: content.stickerAuthor || 'ZapERP' }))
    }
    case 'file': {
      const url = await resolveMediaUrl(provider, row, payload)
      return provider.sendFile(phone, url, content.fileName || 'arquivo', sendOptions(row, payload, { caption: content.caption || '' }))
    }
    case 'contact':
      return provider.sendContact(phone, content.name || 'Contato', content.contactPhone || '', sendOptions(row, payload))
    case 'location':
      return provider.sendLocation(phone, {
        address: content.address || '',
        lat: content.lat,
        lng: content.lng,
      }, sendOptions(row, payload))
    case 'call':
      if (!provider.sendCall) return { ok: false, error: 'Provider nao suporta ligacao' }
      return provider.sendCall(phone, content.callDuration || 5, sendOptions(row, payload))
    default:
      return { ok: false, error: `Tipo de envio nao suportado: ${payload.kind || 'unknown'}` }
  }
}

async function finalizeSuccess(row, result, io) {
  const messageId = result.messageId ? String(result.messageId).trim() : null
  const traceable = isRealWhatsAppId(messageId)

  if (!traceable) {
    const nextAttemptAt = new Date(Date.now() + DEFAULT_ACK_WAIT_MS).toISOString()
    const { data, error } = await supabase
      .from('mensagens')
      .update({
        status: 'pending',
        status_mensagem: 'sending',
        send_status: 'awaiting_ack',
        provider_message_id: messageId || null,
        ultimo_erro_envio: 'Provider aceitou sem ID rastreavel; aguardando webhook/status antes de reenvio manual.',
        ultimo_codigo_erro: 'accepted_without_traceable_id',
        next_attempt_at: nextAttemptAt,
        locked_at: null,
        enviando_ate: null,
        locked_by: null,
      })
      .eq('company_id', row.company_id)
      .eq('id', row.id)
      .select()
      .single()
    if (error) throw error
    emitMessageStatus(io, data, 'pending', 'sending', { send_status: 'awaiting_ack', provider_message_id: messageId || undefined })
    return data
  }

  const { data, error } = await supabase
    .from('mensagens')
    .update({
      status: 'sent',
      status_mensagem: 'sent',
      send_status: 'sent',
      whatsapp_id: messageId,
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
      ultimo_erro_envio: null,
      ultimo_codigo_erro: null,
      locked_at: null,
      enviando_ate: null,
      locked_by: null,
    })
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select()
    .single()
  if (error) throw error
  emitMessageStatus(io, data, 'sent', 'sent', { send_status: 'sent', whatsapp_id: messageId, provider_message_id: messageId })
  return data
}

async function finalizeFailure(row, normalized, classification, io) {
  const attempts = Number(row.tentativas_envio || 0)
  const maxAttempts = Number(row.max_tentativas_envio || DEFAULT_MAX_ATTEMPTS)
  const canRetry = classification.temporary && attempts < maxAttempts
  const update = {
    ultimo_erro_envio: String(classification.reason || normalized?.error || 'Falha ao enviar WhatsApp').slice(0, 500),
    ultimo_codigo_erro: String(classification.code || normalized?.httpStatus || 'provider_error').slice(0, 80),
    locked_at: null,
    enviando_ate: null,
    locked_by: null,
  }
  if (canRetry) {
    update.status = 'pending'
    update.status_mensagem = 'sending'
    update.send_status = 'retry'
    update.next_attempt_at = new Date(Date.now() + computeBackoffMs(attempts)).toISOString()
  } else {
    update.status = 'erro'
    update.status_mensagem = 'failed'
    update.send_status = classification.temporary ? 'failed_retryable' : 'failed'
    update.next_attempt_at = null
  }

  const { data, error } = await supabase
    .from('mensagens')
    .update(update)
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select()
    .single()
  if (error) throw error
  emitMessageStatus(io, data, update.status, update.status_mensagem, {
    erro: update.ultimo_erro_envio,
    tentativa: attempts,
    send_status: update.send_status,
    retry: canRetry,
    em_retry: canRetry,
    falha_recuperavel: update.send_status === 'failed_retryable',
    falha_definitiva: update.send_status === 'failed',
  })
  return data
}

async function finalizeJobSuccess(row, result) {
  const messageId = result.messageId ? String(result.messageId).trim() : null
  const traceable = isRealWhatsAppId(messageId)
  const update = traceable
    ? {
        send_status: 'sent',
        provider_message_id: messageId,
        sent_at: new Date().toISOString(),
        ultimo_erro_envio: null,
        ultimo_codigo_erro: null,
        locked_at: null,
        enviando_ate: null,
        locked_by: null,
        atualizado_em: new Date().toISOString(),
      }
    : {
        send_status: 'awaiting_ack',
        provider_message_id: messageId || null,
        ultimo_erro_envio: 'Provider aceitou sem ID rastreavel; job mantido auditavel.',
        ultimo_codigo_erro: 'accepted_without_traceable_id',
        next_attempt_at: new Date(Date.now() + DEFAULT_ACK_WAIT_MS).toISOString(),
        locked_at: null,
        enviando_ate: null,
        locked_by: null,
        atualizado_em: new Date().toISOString(),
      }

  const { data, error } = await supabase
    .from('whatsapp_outbound_jobs')
    .update(update)
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select()
    .single()
  if (error) throw error
  return data
}

async function finalizeJobFailure(row, normalized, classification) {
  const attempts = Number(row.tentativas_envio || 0)
  const maxAttempts = Number(row.max_tentativas_envio || DEFAULT_MAX_ATTEMPTS)
  const canRetry = classification.temporary && attempts < maxAttempts
  const update = {
    ultimo_erro_envio: String(classification.reason || normalized?.error || 'Falha ao enviar WhatsApp').slice(0, 500),
    ultimo_codigo_erro: String(classification.code || normalized?.httpStatus || 'provider_error').slice(0, 80),
    locked_at: null,
    enviando_ate: null,
    locked_by: null,
    atualizado_em: new Date().toISOString(),
  }
  if (canRetry) {
    update.send_status = 'retry'
    update.next_attempt_at = new Date(Date.now() + computeBackoffMs(attempts)).toISOString()
  } else {
    update.send_status = classification.temporary ? 'failed_retryable' : 'failed'
    update.next_attempt_at = null
  }

  const { data, error } = await supabase
    .from('whatsapp_outbound_jobs')
    .update(update)
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select()
    .single()
  if (error) throw error
  return data
}

async function processOutboundJob(row) {
  const started = Date.now()
  if (!row?.id) return null
  try {
    const providerResult = await dispatchToProvider(row)
    if (providerResult?.skipped) {
      const { data, error } = await supabase
        .from('whatsapp_outbound_jobs')
        .update({
          send_status: 'sent',
          locked_at: null,
          enviando_ate: null,
          locked_by: null,
          ultimo_erro_envio: null,
          ultimo_codigo_erro: null,
          atualizado_em: new Date().toISOString(),
        })
        .eq('company_id', row.company_id)
        .eq('id', row.id)
        .select()
        .single()
      if (error) throw error
      return data
    }

    const normalized = normalizeProviderResult(providerResult)
    console.log('[OUTBOUND_QUEUE_JOB] provider_result', {
      company_id: row.company_id,
      job_id: row.id,
      conversa_id: row.conversa_id || null,
      whatsapp_instance_id: row.whatsapp_instance_id || null,
      telefone_destino: shortPhone(row.send_payload?.phone || row.destination_phone),
      tipo: row.send_payload?.kind || row.kind,
      tentativa: row.tentativas_envio,
      duracao_ms: Date.now() - started,
      ok: normalized.ok,
      http_status: normalized.httpStatus,
      provider_message_id: normalized.messageId || null,
      erro: normalized.error ? String(normalized.error).slice(0, 200) : null,
    })
    if (normalized.ok) return finalizeJobSuccess(row, normalized)
    return finalizeJobFailure(row, normalized, classifyFailure({ result: normalized }))
  } catch (err) {
    const providerResult = err?.providerResult || null
    const normalized = providerResult || normalizeProviderResult(null)
    const classification = classifyFailure({ result: providerResult, error: err })
    console.warn('[OUTBOUND_QUEUE_JOB] send_exception', {
      company_id: row.company_id,
      job_id: row.id,
      conversa_id: row.conversa_id || null,
      whatsapp_instance_id: row.whatsapp_instance_id || null,
      telefone_destino: shortPhone(row.send_payload?.phone || row.destination_phone),
      tipo: row.send_payload?.kind || row.kind,
      tentativa: row.tentativas_envio,
      duracao_ms: Date.now() - started,
      erro: String(err?.message || err).slice(0, 300),
      temporario: classification.temporary,
    })
    return finalizeJobFailure(row, normalized, classification)
  }
}

async function processOutboundMessage(row, io = null) {
  const started = Date.now()
  if (!row?.id) return null
  try {
    emitMessageStatus(io, row, 'pending', 'sending', { send_status: 'sending', tentativa: row.tentativas_envio })
    const providerResult = await dispatchToProvider(row)
    if (providerResult?.skipped) {
      const { data, error } = await supabase
        .from('mensagens')
        .update({
          send_status: 'sent',
          locked_at: null,
          enviando_ate: null,
          locked_by: null,
          ultimo_erro_envio: null,
          ultimo_codigo_erro: null,
        })
        .eq('company_id', row.company_id)
        .eq('id', row.id)
        .select()
        .single()
      if (error) throw error
      return data
    }

    const normalized = normalizeProviderResult(providerResult)
    console.log('[OUTBOUND_QUEUE] provider_result', {
      company_id: row.company_id,
      conversa_id: row.conversa_id,
      mensagem_id: row.id,
      whatsapp_instance_id: row.whatsapp_instance_id,
      telefone_destino: shortPhone(row.send_payload?.phone),
      tipo: row.send_payload?.kind,
      tentativa: row.tentativas_envio,
      duracao_ms: Date.now() - started,
      ok: normalized.ok,
      http_status: normalized.httpStatus,
      provider_message_id: normalized.messageId || null,
      erro: normalized.error ? String(normalized.error).slice(0, 200) : null,
    })
    if (normalized.ok) return finalizeSuccess(row, normalized, io)
    return finalizeFailure(row, normalized, classifyFailure({ result: normalized }), io)
  } catch (err) {
    const providerResult = err?.providerResult || null
    const normalized = providerResult || normalizeProviderResult(null)
    const classification = classifyFailure({ result: providerResult, error: err })
    console.warn('[OUTBOUND_QUEUE] send_exception', {
      company_id: row.company_id,
      conversa_id: row.conversa_id,
      mensagem_id: row.id,
      whatsapp_instance_id: row.whatsapp_instance_id,
      telefone_destino: shortPhone(row.send_payload?.phone),
      tipo: row.send_payload?.kind,
      tentativa: row.tentativas_envio,
      duracao_ms: Date.now() - started,
      erro: String(err?.message || err).slice(0, 300),
      temporario: classification.temporary,
    })
    return finalizeFailure(row, normalized, classification, io)
  }
}

async function sweepStaleOutboundMessages(io = null) {
  const cutoff = new Date(Date.now() - DEFAULT_MAX_AGE_MS).toISOString()
  const { data, error } = await supabase
    .from('mensagens')
    .update({
      status: 'erro',
      status_mensagem: 'failed',
      send_status: 'expired',
      ultimo_erro_envio: 'Mensagem outbound expirou sem confirmacao real do provedor. Reenvio manual necessario.',
      ultimo_codigo_erro: 'outbound_queue_expired',
      locked_at: null,
      enviando_ate: null,
      locked_by: null,
      next_attempt_at: null,
    })
    .eq('direcao', 'out')
    .not('send_payload', 'is', null)
    .is('whatsapp_id', null)
    .in('send_status', ['queued', 'retry', 'sending', 'awaiting_ack'])
    .lt('queued_at', cutoff)
    .select('id, company_id, conversa_id, autor_usuario_id')
  if (error) throw error
  for (const row of data || []) {
    emitMessageStatus(io, row, 'erro', 'failed', { erro: 'outbound_queue_expired' })
  }
  return data || []
}

async function sweepStaleOutboundJobs() {
  const cutoff = new Date(Date.now() - DEFAULT_MAX_AGE_MS).toISOString()
  const { data, error } = await supabase
    .from('whatsapp_outbound_jobs')
    .update({
      send_status: 'expired',
      ultimo_erro_envio: 'Job outbound expirou sem confirmacao real do provedor. Reenvio manual/auditoria necessario.',
      ultimo_codigo_erro: 'outbound_queue_expired',
      locked_at: null,
      enviando_ate: null,
      locked_by: null,
      next_attempt_at: null,
      atualizado_em: new Date().toISOString(),
    })
    .is('provider_message_id', null)
    .in('send_status', ['queued', 'retry', 'sending', 'awaiting_ack'])
    .lt('queued_at', cutoff)
    .select('id, company_id, conversa_id, whatsapp_instance_id, destination_phone, kind')
  if (error) throw error
  for (const row of data || []) {
    console.warn('[OUTBOUND_QUEUE_JOB] expired', {
      company_id: row.company_id,
      job_id: row.id,
      conversa_id: row.conversa_id || null,
      whatsapp_instance_id: row.whatsapp_instance_id || null,
      telefone_destino: shortPhone(row.destination_phone),
      tipo: row.kind,
    })
  }
  return data || []
}

function startOutboundWorker(io, options = {}) {
  if (!outboundWorkerEnabled()) {
    console.log('[OUTBOUND_QUEUE] Worker desativado por WHATSAPP_OUTBOUND_QUEUE_ENABLED=0')
    return { stop() {} }
  }
  const workerId = options.workerId || `wa-out-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS
  const limit = options.limit || DEFAULT_CLAIM_LIMIT
  const lockSeconds = options.lockSeconds || DEFAULT_LOCK_SECONDS
  const maxPerQueue = options.maxPerQueue || DEFAULT_MAX_CONCURRENCY
  const sendDelayMs = options.sendDelayMs ?? DEFAULT_SEND_DELAY_MS
  let running = false
  let stopped = false
  let sweepCounter = 0

  async function tick() {
    if (running || stopped) return
    running = true
    try {
      if (++sweepCounter >= 60) {
        sweepCounter = 0
        await sweepStaleOutboundMessages(io)
        await sweepStaleOutboundJobs()
      }
      const rows = await claimOutboundMessages({ workerId, limit, lockSeconds, maxPerQueue, sendDelayMs })
      for (const row of rows) {
        await processOutboundMessage(row, io)
      }
      const jobs = await claimOutboundJobs({ workerId, limit, lockSeconds, maxPerQueue, sendDelayMs })
      for (const job of jobs) {
        await processOutboundJob(job)
      }
    } catch (err) {
      console.error('[OUTBOUND_QUEUE] worker_tick_error', err?.message || err)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  setImmediate(tick)
  console.log('[OUTBOUND_QUEUE] Worker iniciado', { workerId, intervalMs, limit, lockSeconds, maxPerQueue, sendDelayMs })
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

module.exports = {
  buildQueuePayload,
  classifyFailure,
  claimOutboundJobs,
  claimOutboundMessages,
  computeBackoffMs,
  enqueueOutboundJob,
  enqueueOutboundMessage,
  findExistingByClientTempId,
  isRealWhatsAppId,
  markQueuedMessageFailed,
  normalizeProviderResult,
  processOutboundJob,
  processOutboundMessage,
  requeueOutboundMessage,
  startOutboundWorker,
  sweepStaleOutboundJobs,
  sweepStaleOutboundMessages,
  _test: {
    dispatchToProvider,
    finalizeJobFailure,
    finalizeJobSuccess,
    finalizeFailure,
    finalizeSuccess,
    resolveMediaUrl,
  },
}
