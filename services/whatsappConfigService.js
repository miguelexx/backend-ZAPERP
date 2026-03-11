/**
 * Configuração WhatsApp ( UltraMsg ).
 * Usa tabela empresa_zapi (instance_id, instance_token).
 * Fallback ENV: ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN.
 */

const supabase = require('../config/supabase')

const TIMEOUT_MS = 10_000

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    return res
  } finally {
    clearTimeout(to)
  }
}

async function getEmpresaWhatsappConfig(company_id) {
  if (!company_id) return { error: 'Empresa sem instância configurada' }
  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('instance_id, instance_token, client_token, ativo')
    .eq('company_id', company_id)
    .eq('ativo', true)
    .maybeSingle()

  if (error) {
    console.error('[WHATSAPP-CONFIG] Erro ao buscar empresa_zapi:', error.message)
    return { error: 'Erro ao buscar configuração WhatsApp da empresa' }
  }
  if (data) return { config: data }
  const fallbackId = process.env.ULTRAMSG_INSTANCE_ID || ''
  const fallbackToken = process.env.ULTRAMSG_TOKEN || ''
  if (fallbackId && fallbackToken) {
    return { config: { instance_id: fallbackId, instance_token: fallbackToken, client_token: '', ativo: true } }
  }
  return { error: 'Empresa sem instância configurada' }
}

async function getCompanyIdByInstanceId(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') return null
  const id = String(instanceId).trim()
  if (!id) return null
  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('company_id')
    .eq('instance_id', id)
    .eq('ativo', true)
    .maybeSingle()
  if (error) {
    console.error('[WHATSAPP-CONFIG] Erro ao buscar company_id por instance_id:', error.message)
    return null
  }
  if (data?.company_id != null) return Number(data.company_id)
  const { data: d2, error: e2 } = await supabase
    .from('empresa_zapi')
    .select('company_id')
    .eq('ativo', true)
    .ilike('instance_id', id)
    .order('company_id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!e2 && d2?.company_id != null) return Number(d2.company_id)
  return null
}

module.exports = {
  getEmpresaWhatsappConfig,
  getCompanyIdByInstanceId,
  fetchWithTimeout,
}
