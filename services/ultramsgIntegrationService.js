/**
 * Integração UltraMsg: status, QR code, restart.
 * Usa empresa_zapi (instance_id, instance_token) — client_token não utilizado.
 */

const { getEmpresaWhatsappConfig, getCompanyIdByInstanceId, fetchWithTimeout } = require('./whatsappConfigService')

const ULTRAMSG_BASE_URL = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '')
const TIMEOUT_MS = 10_000
const CONFIGURE_WEBHOOKS_THROTTLE_MS = 10 * 60 * 1000 // 10 minutos entre tentativas de configureWebhooks
const lastConfigureWebhooksAt = new Map()

/** Normaliza instance_id: UltraMsg aceita numérico (51534) ou com prefixo (instance51534). Unifica com provider. */
function normalizeInstanceId(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') return ''
  const id = String(instanceId).trim()
  return id.toLowerCase().startsWith('instance') ? id : `instance${id}`
}

function buildUrl(instanceId, path) {
  const segment = normalizeInstanceId(instanceId)
  return segment ? `${ULTRAMSG_BASE_URL}/${encodeURIComponent(segment)}${path}` : ''
}

async function request(companyId, method, path, body = null) {
  const { config, error } = await getEmpresaWhatsappConfig(companyId)
  if (error || !config) return { error: error || 'Empresa sem instância configurada' }
  const url = buildUrl(config.instance_id, path)
  if (!url) return { error: 'Empresa sem instance_id configurado' }
  const token = encodeURIComponent(config.instance_token)
  const fullUrl = body ? url : `${url}?token=${token}`
  let signal
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(TIMEOUT_MS)
    }
  } catch { /* Node < 17.3 */ }
  const opts = {
    method,
    headers: { accept: 'application/json' },
    ...(signal && { signal })
  }
  if (body && method === 'POST') {
    opts.headers = { ...opts.headers, 'Content-Type': 'application/json' }
    opts.body = JSON.stringify({ ...body, token: config.instance_token })
  }
  try {
    const res = await fetchWithTimeout(fullUrl, opts, TIMEOUT_MS)
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { ok: res.ok, status: res.status, data, text }
  } catch (e) {
    return { error: e?.message || 'UltraMsg inacessível' }
  }
}

function extractBase64(value) {
  if (!value || typeof value !== 'string') return null
  const s = value.trim()
  const match = s.match(/^data:image\/[^;]+;base64,(.+)$/i)
  if (match) return match[1].trim()
  return s
}

async function getStatus(companyId) {
  const { error, ok, data, text } = await request(companyId, 'GET', '/instance/status')
  if (error) return { error }
  if (!ok) {
    return { error: data?.error || data?.message || `HTTP ${data?.status || 500}` }
  }
  // UltraMsg pode retornar status em vários formatos: data.status, data.state, data.instance?.status ou texto
  const status = String(
    data?.status ?? data?.state ?? data?.instance?.status ?? data?.response?.status ?? ''
  ).toLowerCase().trim() || String(text || '').toLowerCase().trim()
  const connected = ['authenticated', 'connected', 'standby'].includes(status) || data?.connected === true
  const smartphoneConnected = connected

  // Ao detectar conexão: configurar webhooks na instância UltraMsg (message_received, message_create, message_ack)
  // Throttle: máximo 1 vez a cada 10 min por empresa para evitar spam à API
  if (connected && companyId) {
    const now = Date.now()
    const last = lastConfigureWebhooksAt.get(companyId) || 0
    if (now - last >= CONFIGURE_WEBHOOKS_THROTTLE_MS) {
      lastConfigureWebhooksAt.set(companyId, now)
      setImmediate(() => {
        const { getProvider } = require('./providers')
        const appUrl = String(process.env.APP_URL || '').trim()
        const provider = getProvider()
        if (appUrl && provider?.configureWebhooks) {
          provider.configureWebhooks(appUrl, { companyId }).catch((e) => {
            console.warn('[ULTRAMSG] configureWebhooks ao conectar:', e?.message || e)
          })
        }
      })
    }
  }

  return { connected, smartphoneConnected }
}

async function getQrCodeImage(companyId) {
  const status = await getStatus(companyId)
  if (status.connected) return { alreadyConnected: true }
  if (status.error) return { error: status.error }

  const { config, error } = await getEmpresaWhatsappConfig(companyId)
  if (error || !config) return { error: error || 'Empresa sem instância configurada' }
  const baseUrl = buildUrl(config.instance_id, '/instance/qrCode')
  if (!baseUrl) return { error: 'Empresa sem instance_id configurado' }
  const url = baseUrl + '?token=' + encodeURIComponent(config.instance_token)
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { accept: 'application/json, image/*, text/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }, TIMEOUT_MS)
    const contentType = (res.headers.get('content-type') || '').toLowerCase()

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      const bodyLower = String(text || JSON.stringify(data || '')).toLowerCase()
      if (bodyLower.includes('authenticated') || bodyLower.includes('connected')) return { alreadyConnected: true }
      return { error: data?.error || data?.message || text?.slice(0, 100) || 'Erro ao buscar QR Code' }
    }

    if (contentType.includes('application/json')) {
      const text = await res.text().catch(() => '')
      const data = text ? JSON.parse(text).catch(() => null) : null
      const raw = data?.qrCode ?? data?.qr ?? data?.qrCodeBase64 ?? data?.image ?? data?.imageBase64 ?? data?.data ?? null
      const imageBase64 = extractBase64(raw) || (typeof raw === 'string' ? raw : null)
      if (imageBase64) return { imageBase64 }
    }

    if (contentType.includes('image') || contentType.includes('text')) {
      const buf = await res.arrayBuffer().catch(() => null)
      if (buf && buf.byteLength > 0) {
        const base64 = Buffer.from(buf).toString('base64')
        return { imageBase64: base64 }
      }
    }

    const text = await res.text().catch(() => '')
    const imageBase64 = extractBase64(text) || (text && text.length < 10000 ? text : null)
    if (imageBase64) return { imageBase64 }
    return { error: 'Resposta UltraMsg sem imagem de QR Code' }
  } catch (e) {
    return { error: e?.message || 'UltraMsg fora do ar' }
  }
}

async function restartInstance(companyId) {
  const { error, ok, data } = await request(companyId, 'POST', '/instance/restart', {})
  if (error) return { error }
  if (!ok) return { error: data?.error || data?.message || 'Erro ao reiniciar' }
  return { value: true }
}

function buildMeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null
  const safe = ['id', 'name', 'due', 'paymentStatus', 'connected', 'phone', 'status']
  const s = {}
  for (const k of safe) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) s[k] = raw[k]
  }
  return Object.keys(s).length ? s : null
}

async function getMe(companyId) {
  const status = await getStatus(companyId)
  if (status.error) return { error: status.error }
  return {
    data: {
      connected: status.connected,
      smartphoneConnected: status.smartphoneConnected,
      phone: null
    }
  }
}

async function getPhoneCode(companyId) {
  return { error: 'Código de telefone não suportado pelo UltraMsg' }
}

module.exports = {
  getStatus,
  getQrCodeImage,
  restartInstance,
  getMe,
  getPhoneCode,
  buildMeSummary,
  getCompanyIdByInstanceId,
  getEmpresaWhatsappConfig
}
