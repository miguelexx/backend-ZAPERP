const rateLimit = require('express-rate-limit')

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      if (message) return res.status(429).json({ error: message })
      return res.status(429).json({ error: 'Too many requests, try again later' })
    },
  })
}

const loginLimiter = limiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many login attempts, try again later',
})

const webhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
})

const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
})

module.exports = { loginLimiter, webhookLimiter, apiLimiter }

