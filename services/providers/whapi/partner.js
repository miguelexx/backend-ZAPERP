/**
 * Partner API Whapi (manager.whapi.cloud) — cria o canal no servidor.
 * Token de parceiro NUNCA vai para o frontend nem para gate.whapi.cloud.
 * Bearer only (não usar ?token=). Ver docs/ai-handoff/25.
 */

const { fetchWithRetry } = require('../../../helpers/retryWithBackoff')

const DEFAULT_MANAGER_URL = 'https://manager.whapi.cloud'
const PARTNER_TIMEOUT_MS = Number(process.env.WHAPI_PARTNER_TIMEOUT_MS) || 30_000

function managerBaseUrl() {
  return String(process.env.WHAPI_MANAGER_URL || DEFAULT_MANAGER_URL).replace(/\/$/, '')
}

function getPartnerToken() {
  return String(process.env.WHAPI_PARTNER_TOKEN || '').trim()
}

function isPartnerConfigured() {
  return !!getPartnerToken()
}

function maskPartnerToken(t) {
  if (!t || typeof t !== 'string') return '***'
  if (t.length <= 4) return '****'
  return `${t.slice(0, 2)}***${t.slice(-2)}`
}

function partnerError(message, extra = {}) {
  const err = new Error(message)
  err.code = extra.code || 'WHAPI_PARTNER'
  err.httpStatus = extra.httpStatus || 502
  return err
}

function createFetchOptions(method, body) {
  let signal
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(PARTNER_TIMEOUT_MS)
    }
  } catch { /* Node antigo */ }
  const headers = { accept: 'application/json' }
  const opts = { method, headers, ...(signal && { signal }) }
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    opts.headers = { ...headers, 'content-type': 'application/json' }
    opts.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return opts
}

async function partnerRequest({ method = 'GET', endpoint, body } = {}) {
  const token = getPartnerToken()
  if (!token) {
    throw partnerError('WHAPI_PARTNER_TOKEN ausente no servidor.', {
      code: 'WHAPI_PARTNER_OFF',
      httpStatus: 503,
    })
  }
  const url = `${managerBaseUrl()}${endpoint}`
  const fetchOpts = createFetchOptions(String(method || 'GET').toUpperCase(), body)
  fetchOpts.headers = {
    ...fetchOpts.headers,
    authorization: `Bearer ${token}`,
  }
  const res = await fetchWithRetry(url, fetchOpts)
  const text = await res.text().catch(() => '')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) {
    const msg = String(data?.error?.message || data?.error || data?.message || text || `HTTP ${res.status}`).slice(0, 240)
    console.warn(JSON.stringify({
      '[WHAPI PARTNER]': { method, endpoint, auth: `Bearer ${maskPartnerToken(token)}`, status: res.status },
    }))
    throw partnerError(msg, { code: 'WHAPI_PARTNER_HTTP', httpStatus: res.status >= 400 ? res.status : 502 })
  }
  return data
}

function pickProjects(data) {
  if (Array.isArray(data?.projects)) return data.projects
  if (Array.isArray(data)) return data
  return []
}

async function resolveProjectId() {
  const fromEnv = String(process.env.WHAPI_PARTNER_PROJECT_ID || '').trim()
  if (fromEnv) return fromEnv
  const data = await partnerRequest({ method: 'GET', endpoint: '/projects?count=20' })
  const list = pickProjects(data)
  const preferred = list.find((p) => p && p.isDefault === true) || list[0]
  const id = preferred?.id != null ? String(preferred.id).trim() : ''
  if (!id) {
    throw partnerError('Nenhum projeto Whapi Partner encontrado. Defina WHAPI_PARTNER_PROJECT_ID.', {
      code: 'WHAPI_PARTNER_NO_PROJECT',
      httpStatus: 503,
    })
  }
  return id
}

function sanitizeChannelName(name, companyId) {
  const fallback = `ZapERP empresa ${companyId || ''}`.trim()
  const raw = String(name || fallback).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80)
  return raw || fallback
}

async function createChannel({ name, companyId } = {}) {
  const projectId = await resolveProjectId()
  const channelName = sanitizeChannelName(name, companyId)
  const data = await partnerRequest({
    method: 'PUT',
    endpoint: '/channels',
    body: { name: channelName, projectId },
  })
  const id = String(data?.id || '').trim()
  const token = String(data?.token || '').trim()
  if (!id || !token) {
    throw partnerError('Whapi Partner criou o canal sem id/token.', {
      code: 'WHAPI_PARTNER_INCOMPLETE',
      httpStatus: 502,
    })
  }
  return {
    id,
    token,
    name: String(data?.name || channelName).trim() || channelName,
    projectId: data?.projectId || projectId,
    apiUrl: data?.apiUrl || null,
  }
}

module.exports = {
  isPartnerConfigured,
  getPartnerToken,
  resolveProjectId,
  createChannel,
  managerBaseUrl,
}
