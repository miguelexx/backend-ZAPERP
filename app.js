const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')
const fs = require('fs')
const tagsRoutes = require('./routes/tagRoutes')
// Usar o mesmo .env do backend (evita carregar .env de outra pasta e sobrescrever APP_URL)
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true })

const app = express()

// =====================================================
// 🔐 Security headers (sempre ativos — não dependem de NODE_ENV)
// - CSP mínimo seguro p/ React SPA + Socket.IO + uploads/mídia
// - X-Frame-Options + frame-ancestors (anti-clickjacking)
// - Referrer-Policy
// - Permissions-Policy (Helmet não cobre nativamente)
// =====================================================
const isProd = process.env.NODE_ENV === 'production'
const defaultDirectives = helmet.contentSecurityPolicy.getDefaultDirectives()

// Ajustes para este projeto (SPA + mídia blob + WS)
defaultDirectives['frame-ancestors'] = ["'none'"]
defaultDirectives['img-src'] = [...new Set([...(defaultDirectives['img-src'] || []), 'blob:'])]
defaultDirectives['media-src'] = ["'self'", 'blob:', 'https:']
defaultDirectives['connect-src'] = ["'self'", 'https:', 'wss:', 'ws:']
defaultDirectives['frame-src'] = ["'none'"]
defaultDirectives['worker-src'] = ["'self'", 'blob:']

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: defaultDirectives,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    xFrameOptions: { action: 'deny' },
  })
)

// Helmet não implementa Permissions-Policy; setamos manualmente.
// Mantém microfone/câmera para o próprio origin; desabilita APIs não usadas.
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=(self)',
      'microphone=(self)',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'bluetooth=()',
      'serial=()',
      'hid=()',
    ].join(', ')
  )
  next()
})

// Em produção, normalmente o app fica atrás de Nginx/Cloudflare (HTTPS).
// Isso melhora req.ip/req.protocol e evita problemas com redirects/URLs.
if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// =====================================================
// JSON parser ANTES de tudo que lê req.body
// verify: mantém rawBody em Buffer para validação HMAC (Meta)
// =====================================================
app.use(express.json({
  verify: (req, res, buf) => {
    try { req.rawBody = buf } catch (_) {}
  }
}))

// =====================================================
// WEBHOOKS — devem ser registrados ANTES do CORS.
// A Z-API (e Meta) enviam header Origin nas chamadas de webhook.
// Se os webhooks ficassem depois do app.use(cors(...)), qualquer
// Origin fora da lista seria bloqueado com 403 antes de chegar ao controller.
// =====================================================
const webhookRoutes = require('./routes/webhookRoutes')
const webhookZapiRoutes = require('./routes/webhookZapiRoutes')
const { webhookLimiter } = require('./middleware/rateLimit')

app.use('/webhook', webhookLimiter, webhookRoutes)
app.use('/webhook/meta', webhookLimiter, webhookRoutes)
app.use('/webhooks/zapi', webhookZapiRoutes)
app.use('/webhook/zapi', webhookZapiRoutes)

// =====================================================
// CORS — aplicado APÓS os webhooks.
// Só as rotas da API/frontend passam por aqui.
// =====================================================
const allowedOrigins = [
  'https://zaperp.wmsistemas.inf.br',
  'https://www.zaperp.wmsistemas.inf.br'
]

const corsOptions = {
  origin(origin, callback) {
    // Requisições sem origin (Postman, apps mobile) → sempre permitir
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error('CORS não permitido para esta origem: ' + origin))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-company-id'],
  credentials: true,
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

// Arquivos estáticos (uploads: imagens, áudios, etc.)
// Segurança:
// - X-Content-Type-Options: nosniff
// - Força download para não-imagens (evita execução/XSS)
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const p = String(filePath || '').toLowerCase()
      const isImage = p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png') || p.endsWith('.webp')
      if (!isImage) {
        const name = p.split(/[\\/]/).pop() || 'download'
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
        // força um tipo genérico para não permitir renderização ativa
        res.setHeader('Content-Type', 'application/octet-stream')
      }
    },
  })
)

// Health check
app.get('/health', (req, res) => res.json({ ok: true }))

// Diagnóstico de ambiente — apenas em desenvolvimento (nunca expor em produção)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/env', (req, res) => {
    res.json({
      APP_URL: process.env.APP_URL || null,
      NODE_ENV: process.env.NODE_ENV || null,
      WEBHOOK_TOKEN_SET: !!String(process.env.ZAPI_WEBHOOK_TOKEN || '').trim(),
    })
  })
}

const userRoutes = require('./routes/userRoutes')
const chatRoutes = require('./routes/chatRoutes')
const dashboardRoutes = require('./routes/dashboardRoutes')
const iaRoutes = require('./routes/iaRoutes')
const configRoutes = require('./routes/configRoutes')
const clienteRoutes = require('./routes/clienteRoutes')
const jobsRoutes = require('./routes/jobsRoutes')
const { apiLimiter } = require('./middleware/rateLimit')
const aiRoutes = require('./routes/aiRoutes')

// Webhooks já registrados antes do CORS (evita 403 Origin)
app.use('/dashboard', dashboardRoutes)
app.use('/jobs', jobsRoutes)
app.use('/ia', iaRoutes)
app.use('/config', configRoutes)
app.use('/clientes', clienteRoutes)
app.use('/usuarios', userRoutes)
app.use('/chats', chatRoutes)
app.use('/tags', tagsRoutes)

// /api — prefixo opcional para SaaS; mantém compatibilidade com rotas antigas
// Aplica apiLimiter globalmente para "rotas de API"
const api = express.Router()
api.use('/dashboard', dashboardRoutes)
api.use('/jobs', jobsRoutes)
api.use('/ia', iaRoutes)
api.use('/ai', aiRoutes)
api.use('/config', configRoutes)
api.use('/clientes', clienteRoutes)
api.use('/usuarios', userRoutes)
api.use('/chats', chatRoutes)
api.use('/tags', tagsRoutes)
app.use('/api', apiLimiter, api)

// =====================================================
// PROD: servir frontend (Vite build) pelo backend
// - 1 processo só (backend + SPA)
// - evita precisar "subir frontend" separado
// =====================================================
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist')
const hasFrontendDist = fs.existsSync(frontendDist) && fs.existsSync(path.join(frontendDist, 'index.html'))

if (hasFrontendDist) {
  // CSS de overrides para melhorar legibilidade/visual sem rebuild do frontend
  const uiOverridesPath = path.join(__dirname, 'ui-overrides.css')
  const uiOverridesHref = '/ui-overrides.css'
  const indexHtmlPath = path.join(frontendDist, 'index.html')
  const indexHtmlRaw = fs.readFileSync(indexHtmlPath, 'utf8')
  const indexHtmlInjected = indexHtmlRaw.includes(uiOverridesHref)
    ? indexHtmlRaw
    : indexHtmlRaw.replace(
        '</head>',
        `  <link rel="stylesheet" href="${uiOverridesHref}" />\n  </head>`
      )

  app.get(uiOverridesHref, (req, res) => {
    try {
      const css = fs.readFileSync(uiOverridesPath, 'utf8')
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
      res.setHeader('Cache-Control', 'public, max-age=300')
      return res.status(200).send(css)
    } catch (e) {
      return res.status(404).send('/* ui-overrides.css não encontrado */')
    }
  })

  app.use(express.static(frontendDist, { index: false }))

  // SPA fallback somente para rotas de frontend (não APIs)
  const apiPrefixes = [
    '/api',
    '/health',
    '/uploads',
    '/dashboard',
    '/jobs',
    '/ia',
    '/config',
    '/clientes',
    '/webhook',
    '/webhooks',
    '/usuarios',
    '/chats',
    '/tags',
  ]

  app.get('*', (req, res, next) => {
    try {
      if (req.method !== 'GET') return next()
      const accept = String(req.headers.accept || '')
      if (!accept.includes('text/html')) return next()
      const p = String(req.path || '/')
      if (apiPrefixes.some((pre) => p === pre || p.startsWith(pre + '/'))) return next()
      return res.status(200).type('html').send(indexHtmlInjected)
    } catch (e) {
      return next(e)
    }
  })
}

// =====================================================
// Global error handler (DEVE ser o último middleware)
// Converte erros do Multer (fileFilter, fileSize) em JSON 400.
// Evita que o Express devolva HTML 500 para erros de upload.
// =====================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer: tipo não permitido ou tamanho excedido
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' || (err.message && err.message.includes('não permitido')))) {
    return res.status(400).json({ error: err.message || 'Arquivo inválido' })
  }
  // CORS
  if (err && String(err.message || '').startsWith('CORS não permitido para esta origem:')) {
    return res.status(403).json({ error: 'CORS: origem não permitida' })
  }
  // Outros erros: log + 500 JSON (nunca HTML)
  console.error('[APP_ERROR]', err?.message || err)
  return res.status(err?.status || 500).json({ error: err?.message || 'Erro interno' })
})

module.exports = app
