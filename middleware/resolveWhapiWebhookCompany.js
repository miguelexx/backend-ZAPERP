'use strict'

/**
 * Resolve channel id (Whapi) → company_id para o webhook /webhooks/whapi.
 * Novo e independente do resolveWebhookCompany (UltraMSG, hardcoded 'ultramsg').
 * Injeta req.webhookContext (+ alias req.zapiContext) com provider='whapi'.
 * Tenant SEMPRE pela instância resolvida — nunca do payload.
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const { getWhatsappInstanceByProviderInstanceId } = require('../services/whatsappInstanceService')

const PROVIDER = 'whapi'

function _logSafe(entry) {
  console.log('[WEBHOOK_WHAPI]', JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}

/** Whapi identifica o canal em `channel_id` (ex. NEBULA-AER3B); tolera variações. */
function extractChannelId(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.channel_id ?? body.channelId ?? body.channel?.id ?? body.instanceId ?? body.instance_id
  if (v == null) return ''
  if (typeof v === 'object' && v.id != null) return String(v.id).trim()
  return String(v).trim()
}

async function resolveWhapiWebhookCompany(req, res, next) {
  if (req.method !== 'POST') return next()
  try {
    const body = req.body || {}
    const channelIdRaw = extractChannelId(body)

    if (!channelIdRaw) {
      req.webhookLogData = { status: 'ignored_missing_channel', provider: PROVIDER }
      _logSafe({ channelId: '(empty)', companyIdResolved: 'missing_channel_id' })
      return res.status(200).json({ ok: true, ignored: 'missing_channel_id' })
    }

    const resolved = await getWhatsappInstanceByProviderInstanceId(PROVIDER, channelIdRaw)

    if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
      req.webhookLogData = { status: 'blocked_duplicate_instance', instance_id: channelIdRaw, provider: PROVIDER }
      _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: 'duplicate_blocked' })
      return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
    }

    const instance = resolved?.instance || null
    const company_id = instance?.company_id ?? null

    if (company_id == null) {
      req.webhookLogData = {
        status: 'ignored_not_mapped',
        instance_id: channelIdRaw,
        provider: PROVIDER,
        error_message: resolved?.error || 'Instancia Whapi nao encontrada para o channel_id recebido',
      }
      _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: 'not_mapped' })
      return res.status(200).json({ ok: true, ignored: 'instance_not_mapped' })
    }

    req.webhookContext = {
      company_id,
      whatsapp_instance_id: instance?.id ?? null,
      provider: PROVIDER,
      provider_instance_id: instance?.instance_id || channelIdRaw,
      instanceId: channelIdRaw,
      connected_phone: instance?.telefone_conectado || instance?.display_phone || null,
      telefone_conectado: instance?.telefone_conectado || null,
      whatsapp_instance_is_default: instance?.is_default === true,
      whatsapp_instance_source: instance?.source || 'whatsapp_instances',
      eventType: 'whapi',
    }
    req.zapiContext = req.webhookContext

    _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: company_id })
    next()
  } catch (e) {
    console.error('[resolveWhapiWebhookCompany]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

module.exports = resolveWhapiWebhookCompany
