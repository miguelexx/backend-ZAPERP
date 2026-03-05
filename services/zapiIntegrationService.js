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
    .eq('ativo', true)
    .maybeSingle()

  if (error) {
    console.error('[ZAPI-INTEGRATION] Erro ao buscar empresa_zapi:', error.message)
    return { error: 'Erro ao buscar configuração Z-API da empresa' }
  }
  if (!data) return { error: 'Empresa sem instância configurada' }
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
      return { needsRestore: true, connected: false, smartphoneConnected: false }
    }
    const alreadyConnected = bodyStr.includes('already connected') || bodyStr.includes('you are already connected')
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`
      if (alreadyConnected) {
        return { connected: true, smartphoneConnected: true }
      }
      console.warn('[ZAPI-INTEGRATION] Status erro (mascarado):', res.status)
      return { error: msg || 'Erro ao consultar status Z-API' }
    }
    const connected = Boolean(data?.connected ?? data?.instance?.connected ?? alreadyConnected)
    const smartphoneConnected = Boolean(
      data?.smartphoneConnected ??
      data?.phone?.connected ??
      data?.instance?.smartphoneConnected
    )
    return { connected, smartphoneConnected }
  } catch (e) {
    console.error('[ZAPI-INTEGRATION] Status exception:', e.message)
    return { error: 'Z-API fora do ar ou inacessível' }
  }
}

/**
 * Extrai base64 puro de string (aceita data:image/...;base64,XXX ou XXX puro).
 */
function extractBase64(value) {
  if (!value || typeof value !== 'string') return null
  const s = value.trim()
  const match = s.match(/^data:image\/[^;]+;base64,(.+)$/i)
  if (match) return match[1].trim()
  return s
}

async function getQrCodeImage(company_id) {
  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error) return { error }
  const base = buildBaseUrl(config.instance_id, config.instance_token)
  const headers = buildHeaders(config.client_token)

  try {
    // 1) Tenta /qr-code/image (retorna JSON com base64)
    const res = await fetchWithTimeout(`${base}/qr-code/image`, {
      method: 'GET',
      headers: { ...headers, accept: 'application/json' }
    })
    const contentType = (res.headers.get('content-type') || '').toLowerCase()

    if (!res.ok) {
      const data = await safeJson(res)
      const bodyLower = JSON.stringify(data || {}).toLowerCase()
      if (bodyLower.includes('already connected') || bodyLower.includes('you are already connected')) {
        return { alreadyConnected: true }
      }
      if (bodyLower.includes('you need to restore the session') || bodyLower.includes('restore the session')) {
        return { needsRestore: true }
      }
      console.warn('[ZAPI-INTEGRATION] QR image erro (mascarado):', res.status)
      return { error: data?.error || data?.message || 'Erro ao buscar QR Code' }
    }

    // Resposta JSON: Z-API pode retornar qr, qrCode, qrCodeBase64, image, imageBase64
    if (contentType.includes('application/json')) {
      const data = await safeJson(res)
      const raw =
        data?.qrCodeBase64 || data?.qrCode || data?.qr || data?.image || data?.imageBase64 || null
      const imageBase64 = extractBase64(raw)
      if (imageBase64) return { imageBase64 }
    }

    // Resposta como texto puro (base64 direto no body)
    if (contentType.includes('text/plain') || contentType.includes('text/')) {
      const text = await res.text().catch(() => '')
      const imageBase64 = extractBase64(text)
      if (imageBase64) return { imageBase64 }
    }

    // 2) Fallback: /qr-code (retorna bytes do QR) e converte para base64
    const resBytes = await fetchWithTimeout(`${base}/qr-code`, {
      method: 'GET',
      headers
    })
    if (resBytes.ok) {
      const buf = await resBytes.arrayBuffer().catch(() => null)
      if (buf && buf.byteLength > 0) {
        const base64 = Buffer.from(buf).toString('base64')
        return { imageBase64: base64 }
      }
    }

    return { error: 'Resposta da Z-API sem imagem de QR Code' }
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
  // Fallback: match case-insensitive (SELECT company_id FROM empresa_zapi WHERE ativo=true AND LOWER(instance_id)=LOWER(id))
  const { data: d2, error: e2 } = await supabase
    .from('empresa_zapi')
    .select('company_id')
    .eq('ativo', true)
    .ilike('instance_id', id)
    .maybeSingle()
  if (!e2 && d2?.company_id != null) return Number(d2.company_id)
  return null
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

