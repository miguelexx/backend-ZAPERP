const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const tagsRoutes = require('./routes/tagRoutes')
require('dotenv').config()


const app = express()

// Em produção, normalmente o app fica atrás de Nginx/Cloudflare (HTTPS).
// Isso melhora req.ip/req.protocol e evita problemas com redirects/URLs.
if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// CORS: em dev pode ser livre; em produção defina CORS_ORIGINS=dominio1,dominio2
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(
  cors({
    origin(origin, cb) {
      // requests sem Origin (curl/postman) devem passar
      if (!origin) return cb(null, true)
      // se não configurou allowlist, permite (modo compatível)
      if (allowedOrigins.length === 0) return cb(null, true)
      if (allowedOrigins.includes(origin)) return cb(null, true)
      return cb(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)
app.use(express.json())

// Arquivos estáticos (uploads: imagens, áudios, etc.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Health check
app.get('/health', (req, res) => res.json({ ok: true }))

const webhookRoutes = require('./routes/webhookRoutes')
const webhookZapiRoutes = require('./routes/webhookZapiRoutes')
const userRoutes = require('./routes/userRoutes')
const chatRoutes = require('./routes/chatRoutes')
const dashboardRoutes = require('./routes/dashboardRoutes')
const iaRoutes = require('./routes/iaRoutes')
const configRoutes = require('./routes/configRoutes')
const clienteRoutes = require('./routes/clienteRoutes')
const jobsRoutes = require('./routes/jobsRoutes')

app.use('/dashboard', dashboardRoutes)
app.use('/jobs', jobsRoutes)
app.use('/ia', iaRoutes)
app.use('/config', configRoutes)
app.use('/clientes', clienteRoutes)
app.use('/webhook', webhookRoutes)
app.use('/webhooks/zapi', webhookZapiRoutes)
app.use('/usuarios', userRoutes)
app.use('/chats', chatRoutes)
app.use('/tags', tagsRoutes)

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

module.exports = app
