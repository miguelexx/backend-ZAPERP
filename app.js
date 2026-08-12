require('express-async-errors')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { loadEnv, isProduction } = require('./config/env')
loadEnv()
const { getUploadsRoot, ensureUploadsRootExists } = require('./config/uploadsRoot')
const { contentTypeForAudioPath } = require('./helpers/audioFormatSniffer')
const tagsRoutes = require('./routes/tagRoutes')
ensureUploadsRootExists()

const isProd = isProduction()

// Origens CORS (definidas antes do Helmet: também alimentam CSP frame-ancestors
// para o SPA em outro host poder exibir PDFs/arquivos de GET /uploads em <iframe>.)
const allowedOrigins = [
  'https://zaperp.wmsistemas.inf.br',
  'https://www.zaperp.wmsistemas.inf.br',
  'http://zaperp.wmsistemas.inf.br',
  'http://www.zaperp.wmsistemas.inf.br',
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000']
    : [])
]
const extraOrigins = [
  ...String(process.env.CORS_ORIGINS || '').split(','),
  ...String(process.env.ZAPERP_CORS_EXTRA_ORIGINS || '').split(','),
].map((s) => s.trim()).filter(Boolean)
extraOrigins.forEach((o) => { if (o && !allowedOrigins.includes(o)) allowedOrigins.push(o) })

const allowedOriginPatterns = [
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.inf\.br$/i,
  /^https?:\/\/[a-z0-9-]+\.wmsistemas\.ats$/i,
]

function buildFrameAncestorsDirective() {
  const s = new Set(["'self'"])
  allowedOrigins.forEach((o) => {
    if (typeof o === 'string' && /^https?:\/\//i.test(o)) s.add(o)
  })
  ;['https://*.wmsistemas.inf.br', 'http://*.wmsistemas.inf.br', 'https://*.wmsistemas.ats', 'http://*.wmsistemas.ats'].forEach((h) => s.add(h))
  return Array.from(s)
}

const app = express()

// =====================================================
// 🔐 Security headers (sempre ativos — não dependem de NODE_ENV)
// - CSP mínimo seguro p/ React SPA + Socket.IO + uploads/mídia
// - frame-ancestors inclui frontends (SPA em outro subdomínio pode iframe /uploads)
// - X-Frame-Options desativado aqui: combinado com frame-ancestors evita bloquear PDF no painel
// - Referrer-Policy
// - Permissions-Policy (Helmet não cobre nativamente)
// =====================================================
const defaultDirectives = helmet.contentSecurityPolicy.getDefaultDirectives()

// Correlaciona logs e respostas sem expor dados sensíveis.
app.use((req, res, next) => {
  req.requestId = req.get('X-Request-Id') || randomUUID()
  res.setHeader('X-Request-Id', req.requestId)
  next()
})

// Ajustes para este projeto (SPA + mídia blob + WS)
defaultDirectives['frame-ancestors'] = buildFrameAncestorsDirective()
defaultDirectives['img-src'] = [...new Set([...(defaultDirectives['img-src'] || []), 'blob:'])]
defaultDirectives['media-src'] = ["'self'", 'blob:', 'https:']
defaultDirectives['connect-src'] = ["'self'", 'https:', 'wss:', 'ws:']
// O visualizador baixa o PDF autenticado e o exibe em <iframe src="blob:...">.
// Sem blob: em frame-src o download termina, mas o navegador bloqueia a renderização.
defaultDirectives['frame-src'] = ["'self'", 'blob:']
defaultDirectives['worker-src'] = ["'self'", 'blob:']

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: defaultDirectives,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    xFrameOptions: false,
    // HSTS: apenas em produção (HTTPS obrigatório). 1 ano + subdomínios.
    hsts: isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
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
// JSON + urlencoded parsers — UltraMSG pode enviar application/json ou form-urlencoded
// verify: mantém rawBody em Buffer (útil para verificação HMAC de webhooks, se aplicável)
// =====================================================
app.use(express.json({
  verify: (req, res, buf) => {
    try { req.rawBody = buf } catch (_) {}
  }
}))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))

// =====================================================
// WEBHOOKS — registrados ANTES do CORS (provedores como UltraMSG enviam Origin).
// =====================================================
const webhookUltramsgRoutes = require('./routes/webhookUltramsgRoutes')
const { webhookLimiter } = require('./middleware/rateLimit')

// UltraMSG: webhook principal (Meta Cloud API removido — usamos apenas UltraMSG)
app.use('/webhooks/ultramsg', webhookLimiter, webhookUltramsgRoutes)
app.use('/webhooks/whatsapp', webhookLimiter, webhookUltramsgRoutes)

// =====================================================
// CORS — aplicado APÓS os webhooks.
// Só as rotas da API/frontend passam por aqui.
// (allowedOrigins / allowedOriginPatterns definidos no topo do arquivo.)
// =====================================================

const corsOptions = {
  origin(origin, callback) {
    // Requisições sem origin (Postman, apps mobile) → sempre permitir
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    if (allowedOriginPatterns.some((re) => re.test(origin))) return callback(null, true)
    return callback(new Error('CORS não permitido para esta origem: ' + origin))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Inclui headers usados pelo frontend para controle de cache (preflight CORS).
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-company-id',
    'Cache-Control',
    'Pragma',
    'Expires',
  ],
  exposedHeaders: [
    'X-Request-Id',
    'X-Chat-List-Limit',
    'X-Chat-List-Has-More',
    'X-Chat-List-Next-Cursor',
    'X-Chat-List-Next-Cursor-Id',
    'X-Chat-List-Sem-Conversa-Included',
  ],
  credentials: true,
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

// Logging de requisições (após CORS para ter req.user disponível nos handlers)
const requestLogger = require('./middleware/logger')
app.use(requestLogger)

// Arquivos estáticos (uploads: imagens, áudios, etc.)
// Segurança:
// - X-Content-Type-Options: nosniff
// - Força download para não-imagens (evita execução/XSS)
app.use(
  '/uploads',
  express.static(getUploadsRoot(), {
    index: false,
    dotfiles: 'deny',
    // Nomes incluem hex aleatório (ex.: inbound-c1-m123-a4b5c6.ogg) → conteúdo imutável.
    // immutable + 365d = browser não revalida; 206 nativo do express.static funciona normalmente.
    maxAge: '365d',
    immutable: true,
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const p = String(filePath || '').toLowerCase()
      const isImage = p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png') || p.endsWith('.webp')
      const isAudio = p.endsWith('.mp3') || p.endsWith('.ogg') || p.endsWith('.oga') || p.endsWith('.aac') || p.endsWith('.m4a') || p.endsWith('.wav') || p.endsWith('.opus') || p.endsWith('.amr') || p.endsWith('.webm')
      const isVideo = p.endsWith('.mp4') || p.endsWith('.mov') || p.endsWith('.avi') || p.endsWith('.3gp')
      const isPdf = p.endsWith('.pdf')
      const isMedia = isImage || isAudio || isVideo || isPdf
      // Para mídia (imagem/áudio/vídeo/PDF), manter Content-Type adequado para provedores
      // e para o painel exibir PDF em iframe. Demais arquivos: download + octet-stream.
      if (!isMedia) {
        const name = p.split(/[\\/]/).pop() || 'download'
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
        // força um tipo genérico para não permitir renderização ativa
        res.setHeader('Content-Type', 'application/octet-stream')
        return
      }
      // O mime padrão do express.static devolve octet-stream para .opus/.amr e audio/x-aac para .aac.
      // Com nosniff, tipo genérico deixa o <audio> sem dica alguma do formato. Só extensões que não
      // existem como vídeo entram aqui — .webm/.3gp seguem com o tipo do container.
      const audioContentType = contentTypeForAudioPath(p)
      if (audioContentType) res.setHeader('Content-Type', audioContentType)
    },
  })
)

// Fallback 404 para /uploads: loga o path resolvido para facilitar diagnóstico de arquivos perdidos.
app.use('/uploads', (req, res) => {
  const resolvedPath = path.join(getUploadsRoot(), req.path)
  console.warn('[uploads] 404 - arquivo não encontrado:', {
    request_path: req.path,
    resolved: resolvedPath,
    uploads_root: getUploadsRoot(),
    uploads_dir_env: process.env.UPLOADS_DIR || '(padrão — UPLOADS_DIR não configurado)',
  })
  res.status(404).json({ error: 'Arquivo não encontrado' })
})

// Health check: básico (LB) e detalhado (Supabase)
const healthController = require('./controllers/healthController')
app.get('/health', healthController.basic)
app.get('/health/detailed', healthController.detailed)

// Página de Permissões (admin) — HTML standalone que consome as APIs
// Permite iframe same-origin para embed na aba Configurações → Permissões
app.get('/permissoes', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.sendFile(path.join(__dirname, 'public', 'permissoes.html'))
})

// Supervisão — painel HTML autônomo (tema claro; pode ser embed same-origin)
app.get('/painel-supervisao', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.sendFile(path.join(__dirname, 'public', 'supervisao.html'))
})

// Diagnóstico de ambiente — apenas em desenvolvimento (nunca expor em produção)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/env', (req, res) => {
    res.json({
      APP_URL: process.env.APP_URL || null,
      NODE_ENV: process.env.NODE_ENV || null,
      WEBHOOK_TOKEN_SET: !!String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim(),
    })
  })
}

const userRoutes = require('./routes/userRoutes')
const chatRoutes = require('./routes/chatRoutes')
const dashboardRoutes = require('./routes/dashboardRoutes')
const iaRoutes = require('./routes/iaRoutes')
const configRoutes = require('./routes/configRoutes')
const whatsappIntegrationRoutes = require('./routes/whatsappIntegrationRoutes')
const clienteRoutes = require('./routes/clienteRoutes')
const jobsRoutes = require('./routes/jobsRoutes')
const { optInRouter, optOutRouter } = require('./routes/optInOptOutRoutes')
const { apiLimiter } = require('./middleware/rateLimit')
const aiRoutes = require('./routes/aiRoutes')
const chatbotDebugRoutes = require('./routes/chatbotDebugRoutes')
const chatbotManagementRoutes = require('./routes/chatbotManagementRoutes')
const internalChatRoutes = require('./routes/internalChatRoutes')
const supervisaoRoutes = require('./routes/supervisaoRoutes')
const produtosRoutes = require('./routes/produtosRoutes')
const printRoutes = require('./routes/printRoutes')
const mediaProxyRoutes = require('./routes/mediaProxyRoutes')
const pushRoutes = require('./routes/pushRoutes')
const minhasPendenciasRoutes = require('./routes/minhasPendenciasRoutes')

// Webhooks já registrados antes do CORS (evita 403 Origin)
app.use('/dashboard', apiLimiter, dashboardRoutes)
app.use('/jobs', apiLimiter, jobsRoutes)
app.use('/ia', apiLimiter, iaRoutes)
app.use('/config', apiLimiter, configRoutes)
app.use('/integrations/whatsapp', apiLimiter, whatsappIntegrationRoutes)
// Alias legado: o frontend historicamente chama /integrations/zapi.
// O provider atual e o contrato real são UltraMsg/WhatsApp, mas as rotas são equivalentes.
app.use('/integrations/zapi', apiLimiter, whatsappIntegrationRoutes)
app.use('/clientes', apiLimiter, clienteRoutes)
app.use('/usuarios', apiLimiter, userRoutes)
app.use('/chats', apiLimiter, chatRoutes)
app.use('/tags', apiLimiter, tagsRoutes)
app.use('/ai', apiLimiter, aiRoutes)
app.use('/opt-in', apiLimiter, optInRouter)
app.use('/opt-out', apiLimiter, optOutRouter)
app.use('/chatbot/debug', apiLimiter, chatbotDebugRoutes)
app.use('/chatbot', apiLimiter, chatbotManagementRoutes)
app.use('/internal-chat', apiLimiter, internalChatRoutes)
app.use('/supervisao', apiLimiter, supervisaoRoutes)
app.use('/produtos', apiLimiter, produtosRoutes)
app.use('/print', apiLimiter, printRoutes)
app.use('/media', apiLimiter, mediaProxyRoutes)
app.use('/push', apiLimiter, pushRoutes)
app.use('/conversas', apiLimiter, minhasPendenciasRoutes)

// /api — prefixo opcional para SaaS; mantém compatibilidade com rotas antigas
// Aplica apiLimiter globalmente para "rotas de API"
const api = express.Router()
api.use('/dashboard', dashboardRoutes)
api.use('/jobs', jobsRoutes)
api.use('/ia', iaRoutes)
api.use('/ai', aiRoutes)
api.use('/config', configRoutes)
api.use('/integrations/whatsapp', whatsappIntegrationRoutes)
api.use('/integrations/zapi', whatsappIntegrationRoutes)
api.use('/clientes', clienteRoutes)
api.use('/usuarios', userRoutes)
api.use('/chats', chatRoutes)
api.use('/tags', tagsRoutes)
api.use('/opt-in', optInRouter)
api.use('/opt-out', optOutRouter)
api.use('/chatbot/debug', chatbotDebugRoutes)
api.use('/chatbot', chatbotManagementRoutes)
api.use('/internal-chat', internalChatRoutes)
api.use('/supervisao', supervisaoRoutes)
api.use('/produtos', produtosRoutes)
api.use('/print', printRoutes)
api.use('/media', mediaProxyRoutes)
api.use('/push', pushRoutes)
api.use('/conversas', minhasPendenciasRoutes)
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
  let indexHtmlInjected = indexHtmlRaw.includes(uiOverridesHref)
    ? indexHtmlRaw
    : indexHtmlRaw.replace(
        '</head>',
        `  <link rel="stylesheet" href="${uiOverridesHref}" />\n  </head>`
      )
  // Refresh automático a cada N minutos (AUTO_REFRESH_MINUTES=0 por padrão; defina >0 para ativar)
  const autoRefreshMinutes = parseInt(process.env.AUTO_REFRESH_MINUTES || '0', 10)
  if (autoRefreshMinutes > 0 && !indexHtmlInjected.includes('auto-refresh-interval')) {
    const refreshScript = `<script id="auto-refresh-interval">(function(){var m=${autoRefreshMinutes}*60*1000;setInterval(function(){location.reload()},m)})();</script>`
    indexHtmlInjected = indexHtmlInjected.includes('</body>')
      ? indexHtmlInjected.replace('</body>', `${refreshScript}\n</body>`)
      : indexHtmlInjected.replace('</html>', `${refreshScript}\n</html>`)
  }

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
    '/ai',
    '/config',
    '/integrations',
    '/clientes',
    '/webhook',
    '/webhooks',
    '/usuarios',
    '/chats',
    '/tags',
    '/opt-in',
    '/opt-out',
    '/chatbot',
    '/internal-chat',
    '/supervisao',
    '/print',
    '/media',
    '/produtos',
    '/push',
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
  // Multer: tipo não permitido, tamanho excedido ou campo inesperado
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' || (err.message && err.message.includes('não permitido')))) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? (err.uploadLimitMessage || 'Vídeo maior que 128 MB. Reduza o arquivo original e tente novamente.')
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Use multipart/form-data com campo "file" ou "audio"'
        : (err.message || 'Arquivo inválido')
    return res.status(400).json({ error: msg })
  }
  // CORS
  if (err && String(err.message || '').startsWith('CORS não permitido para esta origem:')) {
    return res.status(403).json({ error: 'CORS: origem não permitida' })
  }
  // Outros erros: log + 500 JSON (nunca HTML)
  const status = Number(err?.status) || 500
  if (status < 500) {
    return res.status(status).json({ error: err?.message || 'Erro na requisição', requestId: req?.requestId || null })
  }
  const safeMessage = isProd ? 'Erro interno' : (err?.message || 'Erro interno')
  console.error('[APP_ERROR]', {
    requestId: req?.requestId || null,
    method: req?.method || null,
    path: req?.originalUrl || req?.url || null,
    status,
    message: err?.message || String(err || ''),
  })
  return res.status(status).json({ error: safeMessage, requestId: req?.requestId || null })
})

// =====================================================
// 🤖 Inicialização automática do chatbot para todas as empresas
// =====================================================
const { initializeChatbotForAllCompanies } = require('./middleware/autoChatbotSetup')

// Executar inicialização em background após startup.
// Em teste, desativamos para evitar handles pendentes no Jest.
const isAutomatedTest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID
if (!isAutomatedTest) {
  setImmediate(async () => {
    try {
      console.log('[APP] 🤖 Inicializando chatbot para todas as empresas...')
      await initializeChatbotForAllCompanies()
    } catch (error) {
      console.error('[APP] ❌ Erro na inicialização do chatbot:', error.message)
    }
  })
}

module.exports = app
