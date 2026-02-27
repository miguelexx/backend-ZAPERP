'use strict'

const express = require('express')
const router = express.Router()
const rateLimit = require('express-rate-limit')
const auth = require('../middleware/auth')
const aiController = require('../controllers/aiController')

/**
 * Rate limit por empresa + IP: 20 perguntas/minuto.
 * A chave é company_id + IP para isolar multi-tenant rigorosamente.
 * Só é avaliada APÓS auth (req.user já existe).
 */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Chave por company_id (sem req.ip para evitar ERR_ERL_KEY_GEN_IPV6 no express-rate-limit v8)
  // O isolamento multi-tenant por empresa é suficiente para este endpoint.
  keyGenerator: (req) => `ai:${req.user?.company_id ?? 'anon'}`,
  handler: (_req, res) =>
    res.status(429).json({
      ok: false,
      intent: null,
      answer: null,
      data: null,
      error: 'Limite de perguntas atingido (20/min). Aguarde 1 minuto.',
    }),
})

router.post('/ask', auth, aiLimiter, aiController.ask)

module.exports = router
