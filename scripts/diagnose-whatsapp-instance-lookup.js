'use strict'

const { loadEnv } = require('../config/env')
loadEnv()

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

async function main() {
  const instanceId = process.argv[2] || '173587'
  const core = String(instanceId || '').trim().toLowerCase().startsWith('instance')
    ? String(instanceId || '').trim().slice(8).trim()
    : String(instanceId || '').trim()
  const variants = Array.from(new Set([
    String(instanceId || '').trim(),
    core,
    `instance${core}`,
  ].filter(Boolean).flatMap((v) => [v, String(v).toLowerCase()])))
  const supabase = require('../config/supabase')
  const { getWhatsappInstanceByProviderInstanceId } = require('../services/whatsappInstanceService')

  const wi = await supabase
    .from('whatsapp_instances')
    .select('id, company_id, provider, instance_id, ativo, is_default')
    .eq('provider', 'ultramsg')
    .in('instance_id', variants)
    .limit(20)

  const ez = await supabase
    .from('empresa_zapi')
    .select('id, company_id, instance_id, ativo')
    .in('instance_id', variants)
    .limit(20)

  const result = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceId, { includeCredentials: true })
  const instance = result.instance || null

  console.log(JSON.stringify({
    ok: Boolean(instance),
    provider: 'ultramsg',
    instance_id_input: instanceId,
    supabase_project: supabaseProjectHint(),
    company_id: instance?.company_id ?? null,
    whatsapp_instance_id: instance?.id ?? null,
    instance_id: instance?.instance_id ?? null,
    source: instance?.source || 'whatsapp_instances',
    variants,
    direct_whatsapp_instances_error: wi.error?.message || null,
    direct_whatsapp_instances_rows: wi.data || [],
    direct_empresa_zapi_error: ez.error?.message || null,
    direct_empresa_zapi_rows: ez.data || [],
    has_instance_token: Boolean(instance?.instance_token),
    has_client_token: Boolean(instance?.client_token),
    code: result.code || null,
    error: result.error || null,
  }, null, 2))

  if (!instance) process.exitCode = 1
}

main().catch((err) => {
  console.error('[diagnose-whatsapp-instance-lookup]', err?.message || err)
  process.exitCode = 1
})
