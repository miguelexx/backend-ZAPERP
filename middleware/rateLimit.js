const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const jwt = require('jsonwebtoken')

/**
 * Extrai user+company do JWT VERIFICADO — usado apenas para bucketing de rate limit.
 * Garante que usuários autenticados tenham cota individual mesmo atrás de proxy/Traefik compartilhado.
 * A assinatura é verificada: token forjado/inválido cai no bucket por IP (senão qualquer cliente
 * criaria buckets ilimitados e anularia o limite por IP).
 */
function extractJwtBucketKey(req) {
  try {
    const auth = req.headers.authorization || ''
    let token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    // <audio>/<video>/<img> não mandam header: o JWT vai em ?access_token= (ver
    // middleware/authBearerOrQuery). Sem ler a query, TODA reprodução de mídia caía no
    // bucket por IP — um escritório inteiro dividindo uma cota só, e o sintoma de estouro
    // é o áudio simplesmente não tocar (429 silencioso no <audio>). Mesma verificação de
    // assinatura do header: token forjado continua caindo no bucket por IP.
    if (!token) {
      const q = req.query?.access_token ?? req.query?.token
      if (q && typeof q === 'string') token = q.trim()
    }
    if (!token) return null
    const secret = process.env.JWT_SECRET
    if (!secret) return null
    const decoded = jwt.verify(token, secret)
    const uid = decoded?.id || decoded?.sub
    const cid = decoded?.company_id
    if (uid && cid) return `u_${cid}_${uid}`
  } catch { /* token inválido/expirado → bucket por IP */ }
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
  max: numberFromEnv('WEBHOOK_RATE_LIMIT_MAX', 12000),
})

// apiLimiter: usa user_id+company_id como chave quando o JWT está presente,
// garantindo cota individual mesmo que múltiplos usuários compartilhem o mesmo IP de saída
// (cenário comum atrás de Traefik/Coolify). Rotas sem JWT continuam usando IP.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: numberFromEnv('API_RATE_LIMIT_MAX', 6000),
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

