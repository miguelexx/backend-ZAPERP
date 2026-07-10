'use strict'

/**
 * Middleware de log para webhooks.
 * Registra TODOS os webhooks no banco (webhook_logs) — recebidos, processados, ignorados e rejeitados.
 * Executa no res.on('finish') para não bloquear a resposta.
 */

const { logAsync } = require('../services/webhookLogService')

function compactWebhookPayload(body = {}, ctx = {}) {
  const data = body && typeof body.data === 'object' ? body.data : {}
  const rawMessage =
    body.message ?? body.text ?? body.body ?? data.message ?? data.text ?? data.body ?? null
  const mediaUrl =
    body.media ?? body.image?.url ?? body.document?.url ?? body.audio?.url ?? body.video?.url ??
    data.media ?? data.image?.url ?? data.document?.url ?? data.audio?.url ?? data.video?.url ?? null
  const phone =
    body.phone ?? body.from ?? body.to ?? data.phone ?? data.from ?? data.to ?? data.chatId ?? data.author ?? null

  return {
    _log: { path: ctx.path, method: ctx.method },
    event_type: body.event_type ?? body.eventType ?? body.type ?? body.event ?? null,
    instanceId_present: Boolean(body.instanceId ?? body.instance_id ?? data.instanceId ?? data.instance_id),
    // message_id: priorizar o id da MENSAGEM (data.id — formato "true_xxx@lid_ABC").
    // Antes, body.id (id numérico do ENVELOPE do evento UltraMsg) vencia e impedia
    // correlacionar webhook_logs com mensagens.whatsapp_id no diagnóstico.
    message_id: data.id ?? data.messageId ?? data.message_id ?? body.messageId ?? body.message_id ?? body.id ?? null,
    event_envelope_id: body.id ?? null,
    // msg_type: o data.type bruto é a chave para diagnosticar mensagens "(mensagem)" sem conteúdo
    msg_type: data.type ?? body.type ?? null,
    fromMe: body.fromMe ?? data.fromMe ?? null,
    phone_tail: phone ? String(phone).replace(/\D/g, '').slice(-6) || null : null,
    text_length: rawMessage != null ? String(rawMessage).length : 0,
    has_media: Boolean(mediaUrl),
  }
}

/**
 * @param {string} provider - 'ultramsg' | 'meta'
 */
function webhookLogger(provider) {
  return (req, res, next) => {
    const startedAt = Date.now()
    const path = req.path || req.url || '/'
    const method = req.method || 'POST'
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress
    const userAgent = req.get('user-agent') || null
    const body = req.body && typeof req.body === 'object' ? { ...req.body } : {}

    req._webhookLogCtx = { startedAt, path, method, body, ip, userAgent, provider }

    res.on('finish', () => {
      const ctx = req._webhookLogCtx || {}
      const zapi = req.zapiContext || {}
      const logData = req.webhookLogData || {}

      let status = logData.status || 'received'
      const instanceId = logData.instance_id ?? zapi.instanceId ?? (body?.instanceId ?? body?.instance_id)
      const companyId = logData.company_id ?? zapi.company_id
      const eventType = logData.event_type ?? zapi.eventType ?? body?.event_type ?? body?.eventType ?? body?.type

      const fullPayloadEnabled = String(process.env.WEBHOOK_LOG_FULL_PAYLOAD || '').trim() === '1'
      const payload = fullPayloadEnabled
        ? { ...(ctx.body || {}), _log: { path: ctx.path, method: ctx.method } }
        : compactWebhookPayload(ctx.body || {}, ctx)

      logAsync({
        provider: ctx.provider || provider || 'unknown',
        path: ctx.path || path,
        method: ctx.method || method,
        instance_id: instanceId ? String(instanceId) : null,
        company_id: companyId != null ? companyId : null,
        event_type: eventType ? String(eventType) : null,
        status,
        payload,
        ip: ctx.ip || ip,
        user_agent: ctx.userAgent || userAgent,
        response_status: res.statusCode,
        response_body: res.statusCode >= 400 ? { statusCode: res.statusCode, error: logData.error } : { ok: true },
        error_message: logData.error_message || null,
        processing_ms: Date.now() - (ctx.startedAt || startedAt),
      })
    })

    next()
  }
}

module.exports = webhookLogger
