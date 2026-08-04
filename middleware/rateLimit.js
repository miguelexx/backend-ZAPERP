const { rateLimit, ipKeyGenerator } = require('express-rate-limit')

/**
 * Extrai user+company do JWT sem verificar assinatura — usado apenas para bucketing de rate limit.
 * Garante que usuários autenticados tenham cota individual mesmo atrás de proxy/Traefik compartilhado.
 */
function extractJwtBucketKey(req) {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return null
    const payload = token.split('.')[1]
    if (!payload) return null
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const uid = decoded?.id || decoded?.sub
    const cid = decoded?.company_id
    if (uid && cid) return `u_${cid}_${uid}`
  } catch { /* ignore */ }
  return null
}

/** IP real do cliente (importante quando atrás de proxy/Nginx) — evita rate limit compartilhado entre todos os usuários */
function shouldTrustForwardedFor(req) {
  const trustProxy = req?.app?.get?.('trust proxy')
  return trustProxy === true || trustProxy === 1 || trustProxy === '1'
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded && shouldTrustForwardedFor(req)) {
    const first = String(forwarded).split(',')[0].trim()
    if (first) return first
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => ipKeyGenerator(getClientIp(req)),
    handler: (req, res) => {
      if (message) return res.status(429).json({ error: message })
      return res.status(429).json({ error: 'Too many requests, try again later' })
    },
  })
}

const loginLimiter = limiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('LOGIN_RATE_LIMIT_MAX', 20),
  message: 'Muitas tentativas de login. Aguarde 1 minuto e tente novamente.',
})

const webhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('WEBHOOK_RATE_LIMIT_MAX', 60000),
})

// apiLimiter: usa user_id+company_id como chave quando o JWT está presente,
// garantindo cota individual mesmo que múltiplos usuários compartilhem o mesmo IP de saída
// (cenário comum atrás de Traefik/Coolify). Rotas sem JWT continuam usando IP.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: numberFromEnv('API_RATE_LIMIT_MAX', 30000),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const jwtKey = extractJwtBucketKey(req)
    return jwtKey ? ipKeyGenerator(jwtKey) : ipKeyGenerator(getClientIp(req))
  },
  handler: (req, res) => res.status(429).json({ error: 'Too many requests, try again later' }),
})

const destructiveLimiter = limiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('DESTRUCTIVE_RATE_LIMIT_MAX', 300),
  message: 'Muitas acoes sensiveis em pouco tempo. Aguarde 1 minuto e tente novamente.',
})

module.exports = {
  loginLimiter,
  webhookLimiter,
  apiLimiter,
  destructiveLimiter,
  _test: { extractJwtBucketKey, getClientIp },
}

