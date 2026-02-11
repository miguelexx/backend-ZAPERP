const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const tagsRoutes = require('./routes/tagRoutes')
require('dotenv').config()


const app = express()

app.use(cors())
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
      return res.sendFile(path.join(frontendDist, 'index.html'))
    } catch (e) {
      return next(e)
    }
  })
}

module.exports = app
