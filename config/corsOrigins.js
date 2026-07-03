'use strict'

const { isProduction } = require('./env')

const DEFAULT_PRODUCTION_ORIGINS = [
  'https://zaperp.wmsistemas.inf.br',
  'https://www.zaperp.wmsistemas.inf.br',
  'http://zaperp.wmsistemas.inf.br',
  'http://www.zaperp.wmsistemas.inf.br',
  'https://zaperpapi.wmsistemas.inf.br',
]

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.inf\.br$/i,
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.ats$/i,
]

function pushCsv(set, raw) {
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((origin) => set.add(origin))
}

function pushUrlOrigin(set, raw) {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.origin) set.add(u.origin)
  } catch (_) {
    /* ignore */
  }
}

function collectAllowedOrigins() {
  const origins = new Set(DEFAULT_PRODUCTION_ORIGINS)

  pushCsv(origins, process.env.CORS_ORIGINS)
  pushCsv(origins, process.env.ZAPERP_CORS_EXTRA_ORIGINS)
  pushUrlOrigin(origins, process.env.APP_URL)

  if (!isProduction()) {
    DEFAULT_DEV_ORIGINS.forEach((origin) => origins.add(origin))
  }

  return Array.from(origins)
}

function isOriginAllowed(origin) {
  if (!origin) return true
  const allowedOrigins = collectAllowedOrigins()
  if (allowedOrigins.includes(origin)) return true
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
}

module.exports = {
  ALLOWED_ORIGIN_PATTERNS,
  DEFAULT_DEV_ORIGINS,
  DEFAULT_PRODUCTION_ORIGINS,
  collectAllowedOrigins,
  isOriginAllowed,
}
