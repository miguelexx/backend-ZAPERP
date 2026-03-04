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

function extractInstanceId(body) {
  const raw = (
    body?.instanceId != null ? String(body.instanceId) :
    body?.instance_id != null ? String(body.instance_id) :
    body?.instance != null ? String(body.instance) : ''
  ).trim()
  return raw
}

function inferEventType(body, path) {
  const type = String(body?.type ?? body?.event ?? body?.tipo ?? '').trim()
  const p = String(path || '')
  if (p === '/status' || p.endsWith('/status')) return type || 'MessageStatusCallback'
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
    const company_id = instanceIdRaw ? await getCompanyIdByInstanceId(instanceIdRaw) : null
    const companyIdResolved = company_id != null ? company_id : 'not_mapped'
    const eventType = inferEventType(body, path)

    _logSafe({ eventType, instanceId, companyIdResolved })

    req.zapiContext = { company_id, instanceId: instanceIdRaw, eventType }
    if (company_id == null) {
      return res.status(200).json({ ok: true })
    }
    next()
  } catch (e) {
    console.error('[resolveWebhookZapi]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

module.exports = resolveWebhookZapi
