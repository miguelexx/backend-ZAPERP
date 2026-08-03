const {
  buildCrmReferenceId,
} = require('../helpers/whatsappMessageIdHelper')
const {
  classifyManualTextProviderResult,
  sanitizeAuditJson,
} = require('./manualTextOutboundService')

/**
 * Envio transacional de texto automático.
 *
 * A linha é reservada antes do POST para que toda tentativa saia com
 * referenceId=crm-<mensagem.id>. Se a reserva falhar, nada é enviado: uma
 * mensagem sem trilha no banco é pior que uma falha explícita e recuperável.
 */
async function sendAutomaticText({
  supabase,
  sendMessage,
  telefone,
  texto,
  companyId,
  conversaId,
  whatsappInstanceId = null,
  sendOrigin = 'automacao',
  sendOptions = {},
  emitMensagemRealtime = null,
  io = null,
}) {
  const phone = String(telefone || '').trim()
  const body = String(texto || '').trim()
  if (!supabase || typeof sendMessage !== 'function' || !phone || !body || !companyId || !conversaId) {
    return { ok: false, accepted: false, persisted: false, error: 'Dados inválidos para envio automático' }
  }

  const instanceId = whatsappInstanceId == null ? null : Number(whatsappInstanceId)
  const reservePayload = {
    conversa_id: conversaId,
    texto: body,
    direcao: 'out',
    origem: 'automacao',
    company_id: companyId,
    status: 'pending',
    status_mensagem: 'sending',
    provider_delivery_state: 'reserved',
    provider_retryable: true,
    provider_attempt_count: 0,
    ...(Number.isFinite(instanceId) && instanceId > 0 ? { whatsapp_instance_id: instanceId } : {}),
  }

  const { data: reserved, error: reserveError } = await supabase
    .from('mensagens')
    .insert(reservePayload)
    .select('*')
    .single()

  if (reserveError || !reserved?.id) {
    return {
      ok: false,
      accepted: false,
      persisted: false,
      error: reserveError?.message || 'Não foi possível reservar a mensagem automática',
    }
  }

  const referenceId = buildCrmReferenceId(reserved.id)
  const attemptedAt = new Date().toISOString()
  const providerOptions = {
    ...sendOptions,
    companyId,
    conversaId,
    ...(Number.isFinite(instanceId) && instanceId > 0 ? { whatsappInstanceId: instanceId } : {}),
    sendOrigin,
    referenceId,
  }
  const auditRequest = sanitizeAuditJson({
    telefone: phone,
    texto: body,
    options: providerOptions,
  })

  // Persiste a identidade da tentativa antes do POST. Mesmo que este UPDATE
  // falhe, crm-<id> continua derivável pelo reconciliador.
  await supabase
    .from('mensagens')
    .update({
      provider_reference_id: referenceId,
      provider_request: auditRequest,
      provider_delivery_state: 'dispatching',
      provider_last_attempt_at: attemptedAt,
      provider_attempt_count: 1,
    })
    .eq('company_id', companyId)
    .eq('id', reserved.id)

  let rawResult = null
  let thrownError = null
  try {
    rawResult = await sendMessage(phone, body, providerOptions)
  } catch (error) {
    thrownError = error
  }

  const classification = classifyManualTextProviderResult(rawResult, thrownError)
  const uncertain = classification.state === 'uncertain'
  const patch = {
    status: uncertain ? 'pending' : classification.status,
    status_mensagem: uncertain ? 'sending' : classification.status_mensagem,
    provider_reference_id: referenceId,
    provider_request: auditRequest,
    provider_delivery_state: classification.state,
    provider_http_status: classification.provider_http_status,
    provider_response: classification.provider_response,
    provider_error: classification.provider_error,
    provider_retryable: uncertain || classification.retryable === true,
    provider_last_attempt_at: attemptedAt,
    provider_attempt_count: 1,
    ...(classification.whatsapp_id ? { whatsapp_id: classification.whatsapp_id } : {}),
    ...(classification.provider_queue_id ? { provider_queue_id: classification.provider_queue_id } : {}),
  }

  const { data: updated, error: updateError } = await supabase
    .from('mensagens')
    .update(patch)
    .eq('company_id', companyId)
    .eq('id', reserved.id)
    .select('*')
    .maybeSingle()

  const row = updated || { ...reserved, ...patch }
  if (typeof emitMensagemRealtime === 'function') {
    await Promise.resolve(emitMensagemRealtime(row)).catch((error) => {
      console.warn('[automaticTextOutbound] falha ao emitir mensagem:', error?.message || error)
    })
  }

  if (patch.status === 'pending') {
    try {
      const { schedulePendingOutboundReconciliation } = require('./pendingOutboundReconciliationService')
      schedulePendingOutboundReconciliation({ companyId, mensagemId: reserved.id, io })
    } catch (error) {
      console.warn('[automaticTextOutbound] falha ao agendar reconciliação:', error?.message || error)
    }
  }

  return {
    ok: classification.accepted === true,
    accepted: classification.accepted === true,
    queued: classification.queued === true,
    uncertain,
    persisted: true,
    row,
    messageId: classification.whatsapp_id || classification.provider_queue_id || null,
    error: classification.provider_error || updateError?.message || null,
  }
}

module.exports = { sendAutomaticText }
