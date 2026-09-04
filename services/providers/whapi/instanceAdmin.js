/**
 * Admin da instância/canal Whapi. Whapi é WhatsApp Web / canal — NÃO copiar restart UltraMSG.
 * getConnectionStatus: GET /health. configureWebhooks: PATCH /settings (só o campo webhooks).
 * NUNCA no boot da API, NUNCA em instância UltraMSG, NUNCA token na query.
 * QR/pairing (getLoginQr) continua 501 — sessão Whapi autentica no painel Whapi Cloud.
 */

const { get, patch } = require('./http')
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

/** Fase C — QR/pairing (sessão WhatsApp Web do canal Whapi). */
async function getLoginQr() {
  return { ok: false, notImplemented: true, httpStatus: 501, error: 'whapi.getLoginQr só na Fase C (QR/pairing)' }
}

module.exports = {
  getConnectionStatus,
  configureWebhooks,
  getLoginQr,
  WHAPI_WEBHOOK_EVENTS,
}
