/**
 * Resolução de tenant (empresa/instância) do webhook inbound a partir da instância — NUNCA do body.
 * Extraído do topo de receberZapi (controllers/webhookZapiController.js — Fase 5, doc 24) sem alteração
 * de comportamento. Retorna `{ ignored: { status, body } }` quando a request deve ser respondida de
 * imediato (instância duplicada ou não mapeada → 200), ou os identificadores resolvidos.
 *
 * Contrato coberto por tests/receberZapiContract.test.js (not-mapped/duplicate → 200).
 */

const { _extractInstanceIdFromBody } = require('./payload')
const { _logWebhookSafe } = require('./log')
const { getWhatsappInstanceByProviderInstanceId } = require('../../services/whatsappInstanceService')
const { getCompanyIdByInstanceId } = require('../../services/whatsappConfigService')

async function resolveInboundTenant(req) {
  const body = req.body || {}
  // 1) Resolver instanceId e company_id — SEMPRE explícito, NUNCA depender do DEFAULT do banco
  const instanceIdRaw = _extractInstanceIdFromBody(body) || req.zapiContext?.instanceId || ''
  const instanceId = instanceIdRaw ? String(instanceIdRaw).trim() : ''
  let company_id = req.zapiContext?.company_id
  let whatsapp_instance_id = req.zapiContext?.whatsapp_instance_id ?? null
  let whatsapp_instance_is_default = req.zapiContext?.whatsapp_instance_is_default === true
  if (company_id == null && instanceId) {
    const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceId)
    if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
      _logWebhookSafe({
        instanceId: instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : ''),
        companyId: 'duplicate_blocked',
        type: body.type || body.event || 'unknown',
        ignored: 'duplicate_provider_instance',
      })
      return { ignored: { status: 200, body: { ok: true, ignored: 'duplicate_provider_instance' } } }
    }
    if (resolved?.instance) {
      company_id = resolved.instance.company_id
      whatsapp_instance_id = resolved.instance.id ?? null
      whatsapp_instance_is_default = resolved.instance.is_default === true
    } else {
      company_id = await getCompanyIdByInstanceId(instanceId)
    }
  }
  if (!instanceId || company_id == null) {
    const logData = { instanceId: instanceId ? instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : '') : '(empty)', companyId: 'not_mapped', type: body.type || body.event || 'unknown', ignored: 'instance_not_mapped' }
    _logWebhookSafe(logData)
    console.warn('[WEBHOOK_CORE_RESOLVE] ignored_not_mapped no pipeline legado', {
      has_zapi_context: Boolean(req.zapiContext),
      context_company_id: req.zapiContext?.company_id ?? null,
      context_whatsapp_instance_id: req.zapiContext?.whatsapp_instance_id ?? null,
      instance_id_raw: instanceId || null,
      provider: 'ultramsg',
    })

    return { ignored: { status: 200, body: { ok: true, ignored: 'instance_not_mapped' } } }
  }
  return { instanceId, company_id, whatsapp_instance_id, whatsapp_instance_is_default }
}

module.exports = { resolveInboundTenant }
