'use strict'

/**
 * Resolve instanceId (UltraMSG) → company_id para webhooks.
 * Injeta `req.webhookContext` e mantém alias legado `req.zapiContext` (compatibilidade).
 * @see ../docs/reference/ADR-LEGACY-NAMING.md
 */

const { getWhatsappInstanceByProviderInstanceId } = require('../services/whatsappInstanceService')

function _logSafe(entry) {
  console.log('[WEBHOOK]', JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}

function supabaseProjectHint() {
  const raw = String(process.env.SUPABASE_URL || '').trim()
  if (!raw) return 'not_configured'
  try {
    const url = new URL(raw)
    const host = url.hostname || ''
    const ref = host.endsWith('.supabase.co') ? host.split('.')[0] : host
    return ref ? `${url.protocol}//${ref}` : url.protocol
  } catch (_) {
    return 'invalid_url'
  }
}

function _logResolveDecision(entry) {
  const payload = {
    provider: 'ultramsg',
    supabase_project: supabaseProjectHint(),
    ...entry,
  }
  console.log('[WEBHOOK_RESOLVE]', JSON.stringify(payload))
}

function extractInstanceId(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance ??
    body.data?.instanceId ?? body.data?.instance_id
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

function inferEventType(body, path) {
  const p = String(path || '')
  if (p === '/status' || p === '/statusht' || p.endsWith('/status')) {
    return String(body?.type ?? body?.event ?? body?.event_type ?? body?.eventType ?? '').trim() || 'MessageStatusCallback'
  }
  if (p === '/connection' || p.endsWith('/connection')) return String(body?.type ?? body?.event ?? '').trim() || 'ConnectedCallback'
  if (p === '/disconnected' || p.endsWith('/disconnected')) return String(body?.type ?? body?.event ?? '').trim() || 'DisconnectedCallback'
  if (p === '/presence' || p.endsWith('/presence')) return String(body?.type ?? body?.event ?? '').trim() || 'PresenceChatCallback'
  const ev = String(body?.event_type ?? body?.eventType ?? body?.type ?? body?.event ?? body?.tipo ?? '').trim()
  if (ev) return ev
  if (body?.data && typeof body.data === 'object') return body.data?.id ? 'message_received' : 'unknown'
  return 'unknown'
}

async function resolveWebhookCompany(req, res, next) {
  if (req.method !== 'POST') return next()
  try {
    const body = req.body || {}
    const path = req.path || ''
    const instanceIdRaw = extractInstanceId(body)
    const instanceId = instanceIdRaw ? instanceIdRaw.slice(0, 32) : '(empty)'

    if (!instanceIdRaw || !String(instanceIdRaw).trim()) {
      const ev = inferEventType(body, path)
      req.webhookLogData = { status: 'ignored_missing_instance', event_type: ev }
      _logSafe({ eventType: ev, instanceId: '(empty)', companyIdResolved: 'missing_instanceId' })
      return res.status(200).json({ ok: true, ignored: 'missing_instanceId' })
    }

    const eventType = inferEventType(body, path)
    const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceIdRaw)
    _logResolveDecision({
      eventType,
      instance_id_raw: instanceIdRaw,
      service_return_shape: {
        has_instance: Boolean(resolved?.instance),
        has_error: Boolean(resolved?.error),
        code: resolved?.code || null,
      },
      resolved_company_id: resolved?.instance?.company_id ?? null,
      resolved_whatsapp_instance_id: resolved?.instance?.id ?? null,
      resolved_provider_instance_id: resolved?.instance?.instance_id || null,
    })

    if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
      req.webhookLogData = {
        status: 'blocked_duplicate_instance',
        instance_id: instanceIdRaw,
        event_type: eventType,
        provider: 'ultramsg',
      }
      _logSafe({ eventType, instanceId, companyIdResolved: 'duplicate_blocked' })
      return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
    }

    const instance = resolved?.instance || null
    const company_id = instance?.company_id ?? null
    const whatsapp_instance_id = instance?.id ?? null
    const provider_instance_id = instance?.instance_id || instanceIdRaw
    const companyIdResolved = company_id != null ? company_id : 'not_mapped'

    _logSafe({ eventType, instanceId, companyIdResolved })

    req.webhookContext = {
      company_id,
      whatsapp_instance_id,
      provider: 'ultramsg',
      provider_instance_id,
      instanceId: instanceIdRaw,
      eventType,
      whatsapp_instance_is_default: instance?.is_default === true,
      whatsapp_instance_source: instance?.source || 'whatsapp_instances',
    }
    // Compat legado: manter alias até concluir renomeação total.
    req.zapiContext = req.webhookContext

    if (company_id == null) {
      req.webhookLogData = {
        status: 'ignored_not_mapped',
        instance_id: instanceIdRaw,
        event_type: eventType,
        provider: 'ultramsg',
        error_message: resolved?.error || 'Instancia WhatsApp nao encontrada para o instance_id recebido',
      }
      _logResolveDecision({
        eventType,
        instance_id_raw: instanceIdRaw,
        final_status: 'ignored_not_mapped',
        reason: resolved?.error || 'not_found',
      })
      return res.status(200).json({ ok: true, ignored: 'instance_not_mapped' })
    }
    next()
  } catch (e) {
    console.error('[resolveWebhookCompany]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

module.exports = resolveWebhookCompany
