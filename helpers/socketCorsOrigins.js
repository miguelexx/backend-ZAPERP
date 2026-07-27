'use strict'

const { isProduction } = require('../config/env')

/**
 * Origens CORS do Socket.IO — alinhadas ao Express (app.js):
 * - CORS_ORIGINS sempre (em prod: só https://)
 * - ZAPERP_CORS_EXTRA_ORIGINS só fora de produção
 * - APP_URL (em prod: só https)
 * - localhost apenas em não-prod
 */
function collectAllowedSocketOrigins(env = process.env, production = isProduction()) {
  const origins = new Set()
  const pushCsv = (raw, { httpsOnly = false } = {}) => {
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter((o) => o && (!httpsOnly || o.startsWith('https://')))
      .forEach((o) => origins.add(o))
  }
  pushCsv(env.CORS_ORIGINS, { httpsOnly: production })
  if (!production) pushCsv(env.ZAPERP_CORS_EXTRA_ORIGINS)
  try {
    const u = new URL(String(env.APP_URL || '').trim())
    if (u.origin && (!production || u.protocol === 'https:')) origins.add(u.origin)
  } catch (_) {
    /* ignore */
  }
  if (!production) {
    ;[
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ].forEach((o) => origins.add(o))
  }
  return Array.from(origins)
}

module.exports = { collectAllowedSocketOrigins }
