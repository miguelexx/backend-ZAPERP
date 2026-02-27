'use strict'

const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const aiController = require('../controllers/aiController')

// Rate limit específico para o endpoint de IA (10 req/min por IP)
let aiLimiter
try {
  const rateLimit = require('express-rate-limit')
  aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.user?.company_id || 'anon'}_${req.ip}`,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Limite de perguntas atingido. Aguarde 1 minuto.' }),
  })
} catch (_) {
  // express-rate-limit não instalado; prossegue sem limiter
  aiLimiter = (_req, _res, next) => next()
}

router.post('/ask', auth, aiLimiter, aiController.ask)

module.exports = router
