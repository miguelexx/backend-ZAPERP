const supabase = require('../config/supabase')

const ZAPI_TIMEOUT_MS = 10_000

/**
 * Fetch com timeout de 10s para evitar travamentos.
 * NUNCA logar a URL (contém token).
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = ZAPI_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    return res
  } finally {
    clearTimeout(to)
  }
}

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
    const res = await fetchWithTimeout(`${base}/status`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    const bodyStr = JSON.stringify(data || {}).toLowerCase()
    const needsRestore = bodyStr.includes('you need to restore the session') ||
      bodyStr.includes('restore the session')
    if (needsRestore) {
      return { needsRestore: true }
    }
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
    const res = await fetchWithTimeout(`${base}/qr-code/image`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      const bodyLower = JSON.stringify(data || {}).toLowerCase()
      if (bodyLower.includes('already connected') || bodyLower.includes('you are already connected')) {
        return { alreadyConnected: true }
      }
      if (bodyLower.includes('you need to restore the session') || bodyLower.includes('restore the session')) {
        return { needsRestore: true }
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
    const res = await fetchWithTimeout(`${base}/restart`, {
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

/**
 * Mapeia resposta Z-API /me para meSummary (sem tokens).
 */
/**
 * meSummary sem tokens nem URLs que possam conter tokens.
 * Apenas dados básicos: id, name, due, paymentStatus, connected, phone.
 */
function buildMeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null
  const safe = ['id', 'name', 'due', 'paymentStatus', 'connected', 'phone']
  const s = {}
  for (const k of safe) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) s[k] = raw[k]
  }
  return Object.keys(s).length ? s : null
}

async function getMe(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetchWithTimeout(`${base}/me`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      console.warn('[ZAPI-INTEGRATION] /me erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao consultar /me da Z-API' }
    }
    if (!data) return { data: null }
    const clean = { ...data }
    delete clean.token
    delete clean.instanceToken
    delete clean.clientToken
    return { data: clean }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] /me exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

/**
 * Obtém código de verificação de telefone (BR 10-13 dígitos).
 * GET /phone-code/{phone} na Z-API.
 */
async function getPhoneCode(company_id, phone) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 13) {
    return { error: 'Telefone inválido. Use 10 a 13 dígitos (BR).' }
  }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  try {
    const res = await fetchWithTimeout(`${base}/phone-code/${encodeURIComponent(digits)}`, {
      method: 'GET',
      headers: buildHeaders(config.client_token)
    })
    const data = await safeJson(res)
    if (!res.ok) {
      console.warn('[ZAPI-INTEGRATION] phone-code erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao obter código de telefone' }
    }
    const code = data?.code ?? data?.phoneCode ?? data?.value ?? null
    return { code: String(code || '').trim() || null, data }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] phone-code exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

/**
 * Resolve company_id pelo instanceId do payload Z-API (webhooks).
 * Usado quando recebemos callbacks sem contexto de usuário autenticado.
 *
 * @param {string} instanceId - instance_id do payload (body.instanceId)
 * @returns {Promise<number|null>} company_id ou null se não mapeado
 */
async function getCompanyIdByInstanceId(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') return null
  const id = String(instanceId).trim()
  if (!id) return null
  // Match exato; Z-API instance_id pode ser case-sensitive
  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('company_id')
    .eq('instance_id', id)
    .eq('ativo', true)
    .maybeSingle()
  if (error) {
    console.error('[ZAPI-INTEGRATION] Erro ao buscar company_id por instance_id:', error.message)
    return null
  }
  if (data?.company_id != null) return Number(data.company_id)
  // Fallback: match case-insensitive (compatibilidade)
  const { data: d2 } = await supabase
    .from('empresa_zapi')
    .select('company_id, instance_id')
    .eq('ativo', true)
    .limit(20)
  const found = Array.isArray(d2) ? d2.find(r => String(r.instance_id || '').toLowerCase() === id.toLowerCase()) : null
  return found?.company_id != null ? Number(found.company_id) : null
}

module.exports = {
  getStatus,
  getQrCodeImage,
  restartInstance,
  getMe,
  getPhoneCode,
  buildMeSummary,
  getEmpresaZapiConfig,
  getCompanyIdByInstanceId,
  fetchWithTimeout,
}

