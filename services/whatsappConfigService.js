/**
 * Configuração WhatsApp ( UltraMsg ).
 * Usa tabela empresa_zapi (instance_id, instance_token).
 * Fallback ENV: ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN.
 */

const supabase = require('../config/supabase')

const TIMEOUT_MS = 10_000

// Cache em memória para credenciais WhatsApp (dados raramente mudam)
const _empresaConfigCache = new Map()
const _EMPRESA_CONFIG_CACHE_TTL = 5 * 60 * 1000 // 5 minutos

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

  const cacheKey = Number(company_id)
  const cached = _empresaConfigCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < _EMPRESA_CONFIG_CACHE_TTL) {
    return cached.result
  }

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
  if (data) {
    const result = { config: data }
    _empresaConfigCache.set(cacheKey, { ts: Date.now(), result })
    return result
  }
  // Produção: dados APENAS do banco — não usar fallback ENV (multi-tenant vendendo para clientes).
  if (process.env.NODE_ENV === 'production') {
    return { error: 'Empresa sem instância configurada em empresa_zapi. Cadastre credenciais UltraMsg no painel.' }
  }
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
  // UltraMsg webhook envia instanceId numérico (ex: "51534"); banco pode ter "instance51534"
  if (/^\d+$/.test(id)) {
    const altId = `instance${id}`
    const { data: d3, error: e3 } = await supabase
      .from('empresa_zapi')
      .select('company_id')
      .eq('instance_id', altId)
      .eq('ativo', true)
      .maybeSingle()
    if (!e3 && d3?.company_id != null) return Number(d3.company_id)
  } else if (id.toLowerCase().startsWith('instance') && id.length > 8) {
    const numericPart = id.replace(/\D/g, '')
    if (numericPart) {
      const { data: d4, error: e4 } = await supabase
        .from('empresa_zapi')
        .select('company_id')
        .eq('instance_id', numericPart)
        .eq('ativo', true)
        .maybeSingle()
      if (!e4 && d4?.company_id != null) return Number(d4.company_id)
    }
  }
  return null
}

module.exports = {
  getEmpresaWhatsappConfig,
  getCompanyIdByInstanceId,
  fetchWithTimeout,
}
