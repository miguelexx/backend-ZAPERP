/**
 * Interpretação robusta do GET /instance/status do UltraMSG.
 *
 * A API pode devolver status como string OU objeto aninhado
 * (ex.: { status: { accountStatus: { status: "authenticated" } } }).
 * Usar String(data.status) nesses casos vira "[object Object]" e
 * marca a instância como desconectada por engano.
 *
 * Docs: initialize | qr | retrying | loading | authenticated | disconnected | standby
 */

const CONNECTED_STATUSES = new Set(['authenticated', 'connected', 'standby'])
const OFFLINE_STATUSES = new Set([
  'disconnected',
  'desconectado',
  'desconectada',
  'qr',
  'qr_code',
  'qrcode',
  'logged_out',
  'logout',
  'initialize',
  'initializing',
  'loading',
  'retrying',
  'inactive',
  'inativa',
])

function asPlainStatus(value) {
  if (value == null) return ''
  if (typeof value === 'object') return ''
  const s = String(value).toLowerCase().trim()
  if (!s || s === '[object object]') return ''
  return s
}

/**
 * Extrai string de status de payloads UltraMSG (planos ou aninhados).
 */
function extractUltramsgStatusString(data, text) {
  const candidates = [
    data?.accountStatus?.status,
    data?.accountStatus?.substatus,
    typeof data?.accountStatus === 'string' ? data.accountStatus : null,
    data?.status?.accountStatus?.status,
    data?.status?.accountStatus?.substatus,
    typeof data?.status?.accountStatus === 'string' ? data.status.accountStatus : null,
    typeof data?.status === 'string' ? data.status : null,
    data?.status?.status,
    data?.state,
    data?.instance?.status,
    data?.response?.status,
    data?.accountStatusCode,
  ]

  for (const c of candidates) {
    const s = asPlainStatus(c)
    if (s) return s
  }

  try {
    const raw = typeof data === 'string' ? data : JSON.stringify(data ?? {})
    const m = String(raw).toLowerCase().match(
      /\b(authenticated|connected|standby|disconnected|loading|initialize|initializing|qr|retrying)\b/,
    )
    if (m) return m[1] === 'initializing' ? 'initialize' : m[1]
  } catch (_) { /* ignore */ }

  return asPlainStatus(text)
}

/**
 * @returns {{ status: string, connected: boolean, conclusive: boolean }}
 * conclusive=false → não use para forçar "disconnected" no banco/UI.
 */
function interpretUltramsgInstanceStatus(data, text) {
  if (data && data.connected === true) {
    const status = extractUltramsgStatusString(data, text) || 'connected'
    return { status: CONNECTED_STATUSES.has(status) ? status : 'connected', connected: true, conclusive: true }
  }

  const status = extractUltramsgStatusString(data, text)

  if (CONNECTED_STATUSES.has(status)) {
    return { status, connected: true, conclusive: true }
  }

  if (OFFLINE_STATUSES.has(status)) {
    return { status, connected: false, conclusive: true }
  }

  return {
    status: status || 'unknown',
    connected: false,
    conclusive: false,
  }
}

function instanciaStatusConsideradoConectado(status) {
  return CONNECTED_STATUSES.has(String(status || '').toLowerCase().trim())
}

module.exports = {
  CONNECTED_STATUSES,
  OFFLINE_STATUSES,
  extractUltramsgStatusString,
  interpretUltramsgInstanceStatus,
  instanciaStatusConsideradoConectado,
}
