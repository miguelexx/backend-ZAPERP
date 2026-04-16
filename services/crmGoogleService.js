/**
 * Google Calendar OAuth2 + API REST (sem dependência googleapis — usa fetch nativo).
 * Variáveis: CRM_GOOGLE_CLIENT_ID, CRM_GOOGLE_CLIENT_SECRET; redirect = APP_URL + /api/crm/google/callback
 */
const crypto = require('crypto')
const { loadEnv } = require('../config/env')
const repo = require('../repositories/crmRepository')

loadEnv()

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const CAL_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
const CAL_EVENTS = (calId) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

function redirectUriBase() {
  const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '')
  const override = String(process.env.CRM_GOOGLE_REDIRECT_URI || '').trim()
  if (override) return override.replace(/\/$/, '')
  return `${base}/api/crm/google/callback`
}

function getClientCreds() {
  const clientId = String(process.env.CRM_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
  const clientSecret = String(process.env.CRM_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
  return { clientId, clientSecret }
}

function signState(payload) {
  const secret = process.env.JWT_SECRET || ''
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyState(token) {
  const secret = process.env.JWT_SECRET || ''
  if (!token || !String(token).includes('.')) return null
  const [body, sig] = String(token).split('.')
  if (!body || !sig) return null
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(expect)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return null
  try {
    if (!crypto.timingSafeEqual(a, b)) return null
  } catch (_) {
    return null
  }
  try {
    const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const ts = Number(json.ts)
    if (!Number.isFinite(ts) || Date.now() - ts > 15 * 60 * 1000) return null
    return json
  } catch (_) {
    return null
  }
}

function buildAuthUrl(state) {
  const { clientId } = getClientCreds()
  if (!clientId) throw new Error('CRM_GOOGLE_CLIENT_ID não configurado')
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriBase(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  })
  return `${GOOGLE_AUTH}?${params.toString()}`
}

async function exchangeCode(code) {
  const { clientId, clientSecret } = getClientCreds()
  if (!clientId || !clientSecret) throw new Error('Credenciais Google incompletas')
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUriBase(),
    grant_type: 'authorization_code',
  })
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || 'Falha ao trocar código OAuth')
  return j
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getClientCreds()
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || 'Falha ao renovar token Google')
  return j
}

async function getValidAccessToken(companyId, usuarioId) {
  const row = await repo.getGoogleTokens(companyId, usuarioId)
  if (!row || !row.ativo) throw new Error('Google Calendar não conectado')
  const now = Date.now()
  const exp = Number(row.expiry_date) || 0
  if (row.access_token && exp > now + 60_000) {
    return { accessToken: row.access_token, row }
  }
  if (!row.refresh_token) throw new Error('Sem refresh token Google — reconecte a conta')
  const tok = await refreshAccessToken(row.refresh_token)
  const expiryDate = tok.expires_in ? now + tok.expires_in * 1000 : exp
  await repo.updateGoogleTokens(companyId, usuarioId, {
    access_token: tok.access_token,
    expiry_date: expiryDate,
    token_type: tok.token_type || row.token_type,
    scope: tok.scope || row.scope,
  })
  const updated = await repo.getGoogleTokens(companyId, usuarioId)
  return { accessToken: tok.access_token, row: updated }
}

async function fetchCalendarList(companyId, usuarioId) {
  const { accessToken } = await getValidAccessToken(companyId, usuarioId)
  const r = await fetch(`${CAL_LIST}?minAccessRole=writer`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.message || 'Erro ao listar calendários')
  return j.items || []
}

/**
 * Cria ou atualiza evento no Google Calendar (dateTime + timeZone IANA).
 * @param {object} opts
 * @param {string} [opts.calendarId]
 * @param {string} [opts.eventId] — se definido, PATCH no evento existente (evita duplicar)
 * @param {string} opts.startIso
 * @param {string} opts.endIso
 * @param {string} [opts.timeZone='America/Sao_Paulo']
 * @param {Array<{email:string,nome?:string}>} [opts.attendees]
 */
async function createOrUpdateEvent(companyId, usuarioId, opts) {
  const {
    calendarId,
    eventId,
    summary,
    description,
    startIso,
    endIso,
    timeZone = 'America/Sao_Paulo',
    attendees = [],
  } = opts
  const calId = calendarId || 'primary'
  const { accessToken } = await getValidAccessToken(companyId, usuarioId)
  const payload = {
    summary: summary || 'CRM ZapERP',
    description: description || '',
    start: { dateTime: startIso, timeZone },
    end: { dateTime: endIso, timeZone },
  }
  const att = Array.isArray(attendees) ? attendees : []
  if (att.length) {
    payload.attendees = att
      .map((a) => {
        if (typeof a === 'string') return { email: String(a).trim() }
        const email = a?.email != null ? String(a.email).trim() : ''
        if (!email) return null
        const row = { email }
        if (a.nome || a.displayName) row.displayName = String(a.nome || a.displayName)
        return row
      })
      .filter(Boolean)
    if (payload.attendees.length) {
      payload.sendUpdates = 'all'
    }
  }
  const url = eventId
    ? `${CAL_EVENTS(calId)}/${encodeURIComponent(eventId)}`
    : `${CAL_EVENTS(calId)}`
  const r = await fetch(url, {
    method: eventId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.message || j.error || 'Erro ao salvar evento no Google Calendar')
  return j
}

async function deleteEvent(companyId, usuarioId, calendarId, eventId) {
  if (!eventId) return
  const calId = calendarId || 'primary'
  const { accessToken } = await getValidAccessToken(companyId, usuarioId)
  const r = await fetch(`${CAL_EVENTS(calId)}/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!r.ok && r.status !== 404) {
    const j = await r.json().catch(() => ({}))
    throw new Error(j.error?.message || 'Erro ao remover evento do Google')
  }
}

async function fetchGoogleUserEmail(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return null
  return j.email || null
}

module.exports = {
  SCOPES,
  redirectUriBase,
  getClientCreds,
  signState,
  verifyState,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getValidAccessToken,
  fetchCalendarList,
  createOrUpdateEvent,
  deleteEvent,
  fetchGoogleUserEmail,
}
