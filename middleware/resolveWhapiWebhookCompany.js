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

/**
 * Cache TTL curto de resoluções BEM-SUCEDIDAS channel_id→instância. O Whapi posta um
 * webhook a cada mensagem/ACK/presença — sem cache, cada POST fazia o mesmo SELECT.
 * 30s equilibra frescor (rotação de token/metadata propaga em até 30s) e alívio no banco.
 * Erro de banco / canal não mapeado / duplicado NUNCA entram no cache (retry imediato),
 * e a chave é o channel_id exato — impossível cruzar tenant.
 */
const _resolveOkCache = new Map()
const RESOLVE_CACHE_TTL_MS = 30_000
const RESOLVE_CACHE_MAX = 300

function cacheGetInstance(channelId) {
  const hit = _resolveOkCache.get(channelId)
  if (!hit) return null
  if (Date.now() > hit.exp) {
    _resolveOkCache.delete(channelId)
    return null
  }
  return hit.instance
}

function cachePutInstance(channelId, instance) {
  if (_resolveOkCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = _resolveOkCache.keys().next().value
    if (oldest !== undefined) _resolveOkCache.delete(oldest)
  }
  _resolveOkCache.set(channelId, { instance, exp: Date.now() + RESOLVE_CACHE_TTL_MS })
}

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

    const cachedInstance = cacheGetInstance(channelIdRaw)
    const resolved = cachedInstance
      ? { instance: cachedInstance }
      : await getWhatsappInstanceByProviderInstanceId(PROVIDER, channelIdRaw, {
          allowLegacyFallback: false,
        })

    if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
      req.webhookLogData = { status: 'blocked_duplicate_instance', instance_id: channelIdRaw, provider: PROVIDER }
      _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: 'duplicate_blocked' })
      return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
    }

    // Erro de BANCO ≠ canal não mapeado: 500 para o Whapi reentregar (antes virava 200 e perdia).
    if (resolved?.code === 'DB_ERROR') {
      req.webhookLogData = {
        status: 'resolve_db_error',
        instance_id: channelIdRaw,
        provider: PROVIDER,
        error_message: resolved?.error || 'Erro de banco ao resolver canal Whapi',
      }
      _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: 'db_error' })
      return res.status(500).json({ ok: false, error: 'instance_resolve_db_error' })
    }

    const instance = resolved?.instance || null
    const company_id = instance?.company_id ?? null
    if (!cachedInstance && instance && company_id != null) {
      cachePutInstance(channelIdRaw, instance)
    }

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
      // Config de sincronização de histórico por canal (metadata jsonb) — usada pela guarda anti-histórico.
      sync_historico: instance?.metadata?.sync_historico ?? null,
      sync_historico_dias: instance?.metadata?.sync_historico_dias ?? null,
      eventType: 'whapi',
    }
    req.zapiContext = req.webhookContext

    _logSafe({ channelId: channelIdRaw.slice(0, 32), companyIdResolved: company_id })
    next()
  } catch (e) {
    console.error('[resolveWhapiWebhookCompany]', e?.message || e)
    req.webhookLogData = { status: 'resolve_error', provider: PROVIDER, error_message: e?.message || String(e) }
    return res.status(500).json({ ok: false, error: 'instance_resolve_error' })
  }
}

module.exports = resolveWhapiWebhookCompany
module.exports._test = {
  clearResolveCache: () => _resolveOkCache.clear(),
  cacheSize: () => _resolveOkCache.size,
}
