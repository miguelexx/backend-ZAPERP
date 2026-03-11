'use strict'

/**
 * Middleware de log para webhooks.
 * Registra TODOS os webhooks no banco (webhook_logs) — recebidos, processados, ignorados e rejeitados.
 * Executa no res.on('finish') para não bloquear a resposta.
 */

const { logAsync } = require('../services/webhookLogService')

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

      const payload = { ...(ctx.body || {}), _log: { path: ctx.path, method: ctx.method } }

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
