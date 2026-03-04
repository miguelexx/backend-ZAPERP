'use strict'

/**
 * Middleware: resolve instanceId → company_id e injeta em req.zapiContext.
 * Log seguro: { eventType, instanceId, companyIdResolved }
 * Se não mapeado: 200 { ok: true } (nunca expor tokens).
 */

const { getCompanyIdByInstanceId } = require('../services/zapiIntegrationService')

function _logSafe(entry) {
  console.log('[Z-API-WEBHOOK]', JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}

/** Extrai instanceId do payload Z-API (body.instanceId, instance_id, instance.id, instance). */
function extractInstanceId(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

function inferEventType(body, path) {
  const type = String(body?.type ?? body?.event ?? body?.tipo ?? '').trim()
  const p = String(path || '')
  if (p === '/status' || p === '/statusht' || p.endsWith('/status')) return type || 'MessageStatusCallback'
  if (p === '/connection' || p.endsWith('/connection')) return type || 'ConnectedCallback'
  if (p === '/disconnected' || p.endsWith('/disconnected')) return type || 'DisconnectedCallback'
  if (p === '/presence' || p.endsWith('/presence')) return type || 'PresenceChatCallback'
  return type || 'unknown'
}

async function resolveWebhookZapi(req, res, next) {
  if (req.method !== 'POST') return next()
  try {
    const body = req.body || {}
    const path = req.path || ''
    const instanceIdRaw = extractInstanceId(body)
    const instanceId = instanceIdRaw ? instanceIdRaw.slice(0, 32) : '(empty)'

    if (!instanceIdRaw || !String(instanceIdRaw).trim()) {
      _logSafe({ eventType: inferEventType(body, path), instanceId: '(empty)', companyIdResolved: 'missing_instanceId' })
      return res.status(200).json({ ok: true, ignored: 'missing_instanceId' })
    }

    const company_id = await getCompanyIdByInstanceId(instanceIdRaw)
    const companyIdResolved = company_id != null ? company_id : 'not_mapped'
    const eventType = inferEventType(body, path)

    _logSafe({ eventType, instanceId, companyIdResolved })

    req.zapiContext = { company_id, instanceId: instanceIdRaw, eventType }
    if (company_id == null) {
      return res.status(200).json({ ok: true, ignored: 'instance_not_mapped' })
    }
    next()
  } catch (e) {
    console.error('[resolveWebhookZapi]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

module.exports = resolveWebhookZapi
