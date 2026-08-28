'use strict'

const { isProduction } = require('../config/env')

const HARDCODED_FRONTEND_ORIGINS = [
  'https://zaperp.wmsistemas.inf.br',
  'https://www.zaperp.wmsistemas.inf.br',
  'http://zaperp.wmsistemas.inf.br',
  'http://www.zaperp.wmsistemas.inf.br',
]

const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

const allowedOriginPatterns = [
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.inf\.br$/i,
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.ats$/i,
]

function parseCsvOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function originFromAppUrl() {
  try {
    const u = new URL(String(process.env.APP_URL || '').trim())
    return u.origin || ''
  } catch (_) {
    return ''
  }
}

function getAllowedOrigins() {
  const origins = new Set(HARDCODED_FRONTEND_ORIGINS)
  if (!isProduction()) {
    LOCAL_DEV_ORIGINS.forEach((o) => origins.add(o))
  }
  parseCsvOrigins(process.env.CORS_ORIGINS).forEach((o) => origins.add(o))
  parseCsvOrigins(process.env.ZAPERP_CORS_EXTRA_ORIGINS).forEach((o) => origins.add(o))
  const appOrigin = originFromAppUrl()
  if (appOrigin) origins.add(appOrigin)
  return [...origins]
}

function isOriginAllowed(origin) {
  if (!origin) return true
  if (getAllowedOrigins().includes(origin)) return true
  return allowedOriginPatterns.some((re) => re.test(origin))
}

function applyCorsHeaders(req, res) {
  if (!req || !res || res.headersSent) return false
  const origin = req.get?.('Origin') || req.headers?.origin
  if (!origin || !isOriginAllowed(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  const prevVary = String(res.getHeader?.('Vary') || res.getHeader?.('vary') || '')
  if (!/\bOrigin\b/i.test(prevVary)) {
    res.setHeader('Vary', prevVary ? `${prevVary}, Origin` : 'Origin')
  }
  return true
}

module.exports = {
  HARDCODED_FRONTEND_ORIGINS,
  allowedOriginPatterns,
  getAllowedOrigins,
  isOriginAllowed,
  applyCorsHeaders,
}
