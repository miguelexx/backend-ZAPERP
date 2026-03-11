const rateLimit = require('express-rate-limit')

/** IP real do cliente (importante quando atrás de proxy/Nginx) — evita rate limit compartilhado entre todos os usuários */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim()
    if (first) return first
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIp,
    handler: (req, res) => {
      if (message) return res.status(429).json({ error: message })
      return res.status(429).json({ error: 'Too many requests, try again later' })
    },
  })
}

const loginLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Muitas tentativas de login. Aguarde 1 minuto e tente novamente.',
})

const webhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 200,
})

const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: 300,
})

module.exports = { loginLimiter, webhookLimiter, apiLimiter }

