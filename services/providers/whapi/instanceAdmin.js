/**
 * Admin da instância/canal Whapi. Whapi é WhatsApp Web / canal — NÃO copiar restart UltraMSG.
 * getConnectionStatus: GET /health. configureWebhooks: PATCH /settings (só o campo webhooks).
 * QR: GET /users/login/image (PNG) com fallback GET /users/login (base64).
 * Pareamento: GET /users/login/{phone}. Logout: POST /users/logout.
 * NUNCA no boot da API, NUNCA em instância UltraMSG, NUNCA token na query.
 */

const { get, patch, post, getBinary } = require('./http')
const { resolveConfig } = require('./config')

const WHAPI_WEBHOOK_EVENTS = [
  { type: 'messages', method: 'post' },
  { type: 'messages', method: 'put' },
  { type: 'messages', method: 'patch' },
  { type: 'messages', method: 'delete' },
  { type: 'statuses', method: 'post' },
  { type: 'statuses', method: 'put' },
]

/**
 * Configura o webhook do canal Whapi (PATCH /settings, só o campo `webhooks`).
 * NUNCA token na query. Header `X-Webhook-Token` = WHATSAPP_WEBHOOK_TOKEN.
 * Não chama sozinho no boot — só via POST /integrations/whatsapp/instances/:id/configure-webhooks.
 * Preserva o restante das settings (MCP: campo omitido = inalterado).
 */
async function configureWebhooks(appUrl, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !appUrl) return []
  const webhookToken = String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()
  if (!webhookToken) {
    console.warn('[WHAPI] configureWebhooks recusado: WHATSAPP_WEBHOOK_TOKEN ausente')
    return [{ label: 'webhook', ok: false, error: 'WHATSAPP_WEBHOOK_TOKEN ausente' }]
  }
  const webhookUrl = `${String(appUrl).replace(/\/$/, '')}/webhooks/whapi`
  const body = {
    webhooks: [{
      url: webhookUrl,
      mode: 'body',
      events: WHAPI_WEBHOOK_EVENTS,
      headers: { 'X-Webhook-Token': webhookToken },
    }],
  }
  try {
    const { ok, status, data, text } = await patch({
      token: cfg.token,
      endpoint: '/settings',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (ok) {
      console.log('✅ Whapi webhooks configurados:', webhookUrl)
      return [{ label: 'webhook', ok: true, webhook_url: webhookUrl }]
    }
    console.warn('⚠️ Whapi configureWebhooks falhou:', String(text || data?.error || `HTTP ${status}`).slice(0, 200))
    return [{ label: 'webhook', ok: false, webhook_url: webhookUrl }]
  } catch (e) {
    console.warn('⚠️ Whapi configureWebhooks erro:', e?.message || e)
    return [{ label: 'webhook', ok: false, error: e?.message || String(e) }]
  }
}

async function patchProfile(opts, body) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  try {
    const { ok, data } = await patch({
      token: cfg.token,
      endpoint: '/users/profile',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return !!(ok && (!data || data.success !== false) && !data?.error)
  } catch (e) {
    console.warn('❌ Whapi patchProfile falhou:', e?.message || e)
    return false
  }
}

async function updateProfilePicture(url, opts = {}) {
  const value = String(url || '').trim()
  if (!value || !/^https?:\/\//i.test(value)) return false
  return patchProfile(opts, { icon: value })
}

async function updateProfileName(name, opts = {}) {
  const value = String(name || '').trim()
  if (!value) return false
  return patchProfile(opts, { name: value })
}

async function updateProfileDescription(about, opts = {}) {
  return patchProfile(opts, { about: String(about ?? '') })
}

/**
 * Saúde/estado da sessão do canal Whapi.
 * GET /health — o `wakeup` do MCP não se aplica ao nosso HTTP.
 * Retorna { ok, connected, status, raw } — sem lançar (para o painel poder exibir estado).
 */
async function getConnectionStatus(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, connected: false, status: 'not_configured', error: 'Instância Whapi não configurada' }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/health' })
    // GET /health CONFIRMADO (MCP 2026-09-04): { status: { code, text: 'AUTH' }, user: { id: '55…' }, channel_id }.
    const stateText = String(
      data?.status?.text ?? data?.status ?? data?.state ?? (ok ? 'unknown' : 'error')
    ).toUpperCase()
    const connected = stateText === 'AUTH' || stateText === 'CONNECTED' || stateText === 'READY'
    const phone = data?.user?.id != null ? String(data.user.id).replace(/\D/g, '') : null
    return {
      ok,
      connected,
      status: stateText,
      httpStatus: status,
      channelId: data?.channel_id || cfg.channelId || null,
      phone: phone || null,
      raw: data,
    }
  } catch (e) {
    return { ok: false, connected: false, status: 'error', error: e?.message || String(e) }
  }
}

function toQrDataUri(raw, mimeType = 'image/png') {
  const value = String(raw || '').trim()
  if (!value) return null
  if (value.startsWith('data:image/')) return value
  const mime = mimeType && mimeType.startsWith('image/') ? mimeType.split(';')[0] : 'image/png'
  return `data:${mime};base64,${value.replace(/^data:[^;]+;base64,/, '')}`
}

function extractQrDataUri(data) {
  if (!data || typeof data !== 'object') return null
  return toQrDataUri(data.base64 ?? data.image ?? data.qr ?? data.qrBase64 ?? data.dataUri)
}

function loginQueryParams(opts = {}) {
  const extraParams = { wakeup: 'true' }
  if (opts?.size) extraParams.size = String(opts.size)
  if (opts?.width) extraParams.width = String(opts.width)
  if (opts?.height) extraParams.height = String(opts.height)
  if (opts?.color_light) extraParams.color_light = String(opts.color_light)
  if (opts?.color_dark) extraParams.color_dark = String(opts.color_dark)
  return extraParams
}

function alreadyAuthenticatedResult(status) {
  return {
    ok: false,
    httpStatus: status,
    alreadyAuthenticated: true,
    error: `Whapi não retornou QR (HTTP ${status}). O canal pode já estar conectado (AUTH).`,
  }
}

async function getLoginQrFromJson(cfg, extraParams) {
  const { ok, status, data } = await get({
    token: cfg.token,
    endpoint: '/users/login',
    extraParams,
  })
  if (status === 409) return alreadyAuthenticatedResult(status)
  const image = extractQrDataUri(data)
  if (!ok || !image) {
    return {
      ok: false,
      httpStatus: status,
      error: String(data?.error?.message || data?.error || `Whapi não retornou QR (HTTP ${status}). O canal pode já estar conectado (AUTH).`),
    }
  }
  return { ok: true, image, mimeType: 'image/png', httpStatus: status, source: 'json' }
}

function parseJsonBuffer(buffer, contentType) {
  const ct = String(contentType || '')
  if (!buffer || !buffer.length) return null
  if (!ct.includes('json') && buffer[0] !== 0x7b) return null
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * QR-code de login do canal Whapi (conectar pelo painel do ZapERP).
 * 1) GET /users/login/image → PNG (loginUserImage)
 * 2) Fallback GET /users/login → JSON base64 (loginUser)
 * `wakeup=true` para o canal subir e gerar o QR.
 * Só produz QR se o canal NÃO estiver conectado (estado AUTH / HTTP 409).
 * Retorna { ok, image: dataUri, mimeType } — sem send guard (leitura).
 */
async function getLoginQr(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const extraParams = loginQueryParams(opts)
  try {
    const { ok, status, buffer, contentType } = await getBinary({
      token: cfg.token,
      endpoint: '/users/login/image',
      extraParams,
    })
    if (status === 409) return alreadyAuthenticatedResult(status)
    if (ok && buffer && buffer.length) {
      const fromJson = extractQrDataUri(parseJsonBuffer(buffer, contentType))
      if (fromJson) return { ok: true, image: fromJson, mimeType: 'image/png', httpStatus: status, source: 'image-json' }
      const looksPng = buffer[0] === 0x89 && buffer[1] === 0x50
      const looksJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
      if (looksPng || looksJpeg || String(contentType || '').startsWith('image/')) {
        const mimeType = contentType && contentType.startsWith('image/') ? contentType.split(';')[0] : (looksJpeg ? 'image/jpeg' : 'image/png')
        return { ok: true, image: `data:${mimeType};base64,${buffer.toString('base64')}`, mimeType, httpStatus: status, source: 'image' }
      }
    }
    return getLoginQrFromJson(cfg, extraParams)
  } catch (e) {
    try {
      return getLoginQrFromJson(cfg, extraParams)
    } catch (inner) {
      return { ok: false, error: `Falha de conexão ao obter QR (Whapi): ${inner?.message || e?.message || e}` }
    }
  }
}

/**
 * Código de pareamento (login sem QR). GET /users/login/{PhoneNumber} → { code }.
 * O usuário digita o código no WhatsApp do celular. Só se o canal NÃO estiver conectado.
 * Retorna { ok, code, error }.
 */
async function getLoginCode(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return { ok: false, error: 'Telefone inválido para pareamento' }
  try {
    const { ok, status, data } = await get({
      token: cfg.token,
      endpoint: `/users/login/${encodeURIComponent(digits)}`,
    })
    const code = data?.code != null ? String(data.code) : null
    if (!ok || !code) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) + (status === 409 ? ' (canal já autenticado)' : '') }
    }
    return { ok: true, code, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao obter código (Whapi): ${e?.message || e}` }
  }
}

/**
 * Encerra a sessão WhatsApp do canal (POST /users/logout).
 * Não apaga o cadastro da instância no ZapERP — só desconecta o número.
 * skipSendGuard: não é envio. 409 = já estava desconectado (tratado como ok).
 */
async function logoutUser(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: '/users/logout',
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (ok || status === 409) {
      return { ok: true, alreadyLoggedOut: status === 409, httpStatus: status }
    }
    return {
      ok: false,
      httpStatus: status,
      error: String(data?.error?.message || data?.error || `HTTP ${status}`),
    }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao desconectar (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getConnectionStatus,
  configureWebhooks,
  getLoginQr,
  getLoginCode,
  logoutUser,
  updateProfilePicture,
  updateProfileName,
  updateProfileDescription,
  WHAPI_WEBHOOK_EVENTS,
}
