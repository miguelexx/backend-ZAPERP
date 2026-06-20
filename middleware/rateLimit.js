const { rateLimit, ipKeyGenerator } = require('express-rate-limit')

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

const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('API_RATE_LIMIT_MAX', 30000),
})

const destructiveLimiter = limiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('DESTRUCTIVE_RATE_LIMIT_MAX', 300),
  message: 'Muitas acoes sensiveis em pouco tempo. Aguarde 1 minuto e tente novamente.',
})

module.exports = { loginLimiter, webhookLimiter, apiLimiter, destructiveLimiter }

