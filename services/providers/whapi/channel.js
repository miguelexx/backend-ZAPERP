/**
 * Channel Whapi: health já está em instanceAdmin.getConnectionStatus.
 * GET/PATCH/DELETE /settings · GET /settings/events · POST /settings/webhook_test · GET /limits.
 * PATCH omitido = inalterado (contrato oficial). DELETE /settings é destrutivo — exige confirm:true.
 */

const { get, patch, del, post } = require('./http')
const { resolveConfig } = require('./config')

const SETTINGS_KEYS = new Set([
  'pdo_sync',
  'callback_backoff_delay_ms',
  'max_callback_backoff_delay_ms',
  'callback_persist',
  'media',
  'webhooks',
  'proxy',
  'mobile_proxy',
  'offline_mode',
  'full_history',
  'auto_read_messages',
  'outgoing_calls_enabled',
  'locale',
  'mock_pairing_code',
  'ignored_presences',
  'data_mode',
])

const WEBHOOK_TEST_TYPES = new Set([
  'messages', 'statuses', 'chats', 'contacts', 'groups', 'presences',
  'calls', 'channel', 'users', 'labels', 'service',
])
const WEBHOOK_TEST_MODES = new Set(['body', 'path', 'method'])

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data) {
  return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
}

async function getChannelSettings(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/settings' })
    if (!ok || data?.error) return apiError(status, data)
    return { ok: true, settings: data, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler settings (Whapi): ${e?.message || e}` }
  }
}

/**
 * PATCH /settings — só envia chaves conhecidas presentes em `fields`.
 * Não substitui webhooks a menos que `fields.webhooks` venha explícito.
 */
async function updateChannelSettings(fields = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const body = {}
  if (!fields || typeof fields !== 'object') {
    return { ok: false, error: 'Payload de settings inválido' }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (SETTINGS_KEYS.has(key) && value !== undefined) body[key] = value
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nenhum campo de settings para atualizar' }
  try {
    const { ok, status, data } = await patch({
      token: cfg.token,
      endpoint: '/settings',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) return apiError(status, data)
    return { ok: true, httpStatus: status, settings: data }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao atualizar settings (Whapi): ${e?.message || e}` }
  }
}

/**
 * DELETE /settings — zera a config do canal (inclui webhooks). Só dispara com confirm:true.
 */
async function resetChannelSettings(opts = {}) {
  if (opts.confirm !== true) {
    return { ok: false, error: 'Confirmação obrigatória (confirm:true). Reset apaga webhooks e demais settings do canal.' }
  }
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: '/settings',
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if ((!ok && status !== 409) || data?.error) return apiError(status, data)
    return { ok: true, httpStatus: status, alreadyReset: status === 409 }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao resetar settings (Whapi): ${e?.message || e}` }
  }
}

async function getAllowedEvents(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, events: [], error: 'Instância Whapi não configurada' }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/settings/events' })
    if (!ok || data?.error) {
      return { ...apiError(status, data), events: [] }
    }
    const events = Array.isArray(data) ? data : (Array.isArray(data?.events) ? data.events : [])
    return { ok: true, events, httpStatus: status }
  } catch (e) {
    return { ok: false, events: [], error: `Falha de conexão ao listar eventos (Whapi): ${e?.message || e}` }
  }
}

/**
 * POST /settings/webhook_test — dispara um callback de teste para `url`.
 * Não altera as settings permanentes do canal.
 */
async function testWebhook(payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const type = String(payload.type || '').trim()
  const url = String(payload.url || '').trim()
  const mode = String(payload.mode || 'body').trim()
  if (!WEBHOOK_TEST_TYPES.has(type)) {
    return { ok: false, error: `type de webhook inválido: use ${[...WEBHOOK_TEST_TYPES].join('|')}` }
  }
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return { ok: false, error: 'url do webhook de teste é obrigatória' }
  }
  if (!WEBHOOK_TEST_MODES.has(mode)) {
    return { ok: false, error: 'mode inválido: body|path|method' }
  }
  const body = {
    type,
    url,
    mode,
    ...(payload.send_undecrypted_ad === true ? { send_undecrypted_ad: true } : {}),
    ...(Number.isFinite(Number(payload.webhook_max_age_seconds))
      ? { webhook_max_age_seconds: Number(payload.webhook_max_age_seconds) }
      : {}),
    ...(payload.headers && typeof payload.headers === 'object' ? { headers: payload.headers } : {}),
  }
  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: '/settings/webhook_test',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) return apiError(status, data)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão no teste de webhook (Whapi): ${e?.message || e}` }
  }
}

async function getLimits(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/limits' })
    if (status === 204) return { ok: true, unlimited: true, limits: null, httpStatus: 204 }
    if (!ok || data?.error) return apiError(status, data)
    return { ok: true, unlimited: false, limits: data, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler limites (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getChannelSettings,
  updateChannelSettings,
  resetChannelSettings,
  getAllowedEvents,
  testWebhook,
  getLimits,
}
