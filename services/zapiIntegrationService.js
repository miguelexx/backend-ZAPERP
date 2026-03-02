const supabase = require('../config/supabase')
const fetch = require('node-fetch')

/**
 * Busca configuração Z-API da empresa.
 * Nunca recebe company_id do frontend; sempre vem do req.user.
 */
async function getEmpresaZapiConfig(company_id) {
  if (!company_id) return { error: 'Empresa sem instância configurada' }
  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('instance_id, instance_token, client_token, ativo')
    .eq('company_id', company_id)
    .maybeSingle()

  if (error) {
    console.error('[ZAPI-INTEGRATION] Erro ao buscar empresa_zapi:', error.message)
    return { error: 'Erro ao buscar configuração Z-API da empresa' }
  }
  if (!data || data.ativo === false) {
    return { error: 'Empresa sem instância configurada' }
  }
  return { config: data }
}

function buildBaseUrl(instance_id, instance_token) {
  const base = (process.env.ZAPI_BASE_URL || 'https://api.z-api.io').replace(/\/$/, '')
  return `${base}/instances/${encodeURIComponent(instance_id)}/token/${encodeURIComponent(instance_token)}`
}

function buildHeaders(client_token) {
  const headers = { accept: 'application/json' }
  if (client_token) headers['Client-Token'] = client_token
  return headers
}

async function safeJson(res) {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function getStatus(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetch(`${base}/status`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`
      console.warn('[ZAPI-INTEGRATION] Status erro (mascarado):', res.status)
      return { error: msg || 'Erro ao consultar status Z-API' }
    }
    const connected = Boolean(data?.connected ?? data?.instance?.connected)
    const smartphoneConnected = Boolean(
      data?.smartphoneConnected ??
      data?.phone?.connected ??
      data?.instance?.smartphoneConnected
    )
    return { connected, smartphoneConnected, raw: data }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] Status exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

async function getQrCodeImage(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetch(`${base}/qr-code/image`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      const bodyLower = JSON.stringify(data || {}).toLowerCase()
      if (bodyLower.includes('already connected') || bodyLower.includes('you are already connected')) {
        return { alreadyConnected: true }
      }
      console.warn('[ZAPI-INTEGRATION] QR erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao buscar QR Code' }
    }
    const imageBase64 =
      data?.qrCodeBase64 ||
      data?.image ||
      data?.imageBase64 ||
      null
    if (!imageBase64) {
      return { error: 'Resposta da Z-API sem imagem de QR Code' }
    }
    return { imageBase64 }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] QR exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

async function restartInstance(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetch(`${base}/restart`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      console.warn('[ZAPI-INTEGRATION] Restart erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao reiniciar instância' }
    }
    const value = Boolean(data?.value ?? data?.success ?? true)
    return { value }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] Restart exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

async function getMe(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetch(`${base}/me`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      console.warn('[ZAPI-INTEGRATION] /me erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao consultar /me da Z-API' }
    }
    if (data && data.instanceToken) delete data.instanceToken
    if (data && data.clientToken) delete data.clientToken
    return { data }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] /me exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

module.exports = {
  getStatus,
  getQrCodeImage,
  restartInstance,
  getMe,
}

