const path = require('path')
const { loadEnv, getBooleanEnv, isProduction } = require('./config/env')
loadEnv()
const http = require('http')
const app = require('./app')
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const supabase = require('./config/supabase')

// Diagnóstico: em produção, logs mínimos (nunca expor tokens, senhas ou paths sensíveis)
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.join(__dirname, '.env')
  console.log('[ENV] Carregado:', envPath)
  console.log('APP_URL:', process.env.APP_URL || '(não definido)')
}
console.log('NODE_ENV:', process.env.NODE_ENV || 'development')

// Detecta NODE_ENV malformado (ex: falta newline no .env → NODE_ENV=productionULTRAMSG_BASE_URL=...)
const nodeEnv = String(process.env.NODE_ENV || '').trim()
const SOCKET_DEBUG = process.env.SOCKET_DEBUG === '1' || process.env.NODE_ENV !== 'production'

/** Rate limit leve por socket (anti-flood inbound). Não altera autorização. */
const SOCKET_RATE = {
  join_conversa: { windowMs: 10_000, max: 40 },
  marcar_conversa_lida: { windowMs: 10_000, max: 30 },
  typing: { windowMs: 5_000, max: 25 },
}

function createSocketRateLimiter() {
  const buckets = new Map()
  return function allowSocketEvent(socketId, eventKey) {
    const cfg = SOCKET_RATE[eventKey]
    if (!cfg) return true
    const now = Date.now()
    const key = `${socketId}:${eventKey}`
    let b = buckets.get(key)
    if (!b || now - b.windowStart >= cfg.windowMs) {
      b = { windowStart: now, count: 0 }
      buckets.set(key, b)
    }
    b.count += 1
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now - v.windowStart >= 60_000) buckets.delete(k)
      }
    }
    return b.count <= cfg.max
  }
}

const allowSocketEvent = createSocketRateLimiter()

if (nodeEnv && (nodeEnv.includes('ULTRAMSG') || nodeEnv.includes('='))) {
  console.warn(
    '[ENV] NODE_ENV parece concatenado com outra variável. Verifique o .env: cada variável deve estar em uma linha separada.'
  )
}

// Fail-fast: configuração crítica obrigatória — impede deploy inseguro.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET não configurado no .env')
}
if (!String(process.env.APP_URL || '').trim()) {
  throw new Error('APP_URL não definido no .env')
}
const webhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN || ''
if (!String(webhookToken).trim()) {
  throw new Error('WHATSAPP_WEBHOOK_TOKEN não definido no .env')
}
if (!String(process.env.NODE_ENV || '').trim()) {
  throw new Error('NODE_ENV não definido no .env')
}

const server = http.createServer(app)

// CORS do Socket.IO: alinhado ao Express (CORS_ORIGINS + ZAPERP_CORS_EXTRA_ORIGINS + APP_URL + dev local).
function collectAllowedSocketOrigins() {
  const origins = new Set()
  const pushCsv = (raw) => {
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((o) => origins.add(o))
  }
  pushCsv(process.env.CORS_ORIGINS)
  pushCsv(process.env.ZAPERP_CORS_EXTRA_ORIGINS)
  try {
    const u = new URL(String(process.env.APP_URL || '').trim())
    if (u.origin) origins.add(u.origin)
  } catch (_) {
    /* ignore */
  }
  if (!isProduction()) {
    ;[
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ].forEach((o) => origins.add(o))
  }
  return Array.from(origins)
}

const allowedSocketOrigins = collectAllowedSocketOrigins()

const internalChatSocket = require('./socket/internalChatSocket')
const { startAbsenceFinalizationScheduler } = require('./services/absenceFinalizationScheduler')
const { startAdminAtendimentoAlertaScheduler } = require('./services/adminAtendimentoAlertaScheduler')
const { startAtendimentoSemRespostaScheduler } = require('./services/atendimentoSemRespostaScheduler')
const { startProdutosSyncScheduler } = require('./services/produtosSyncScheduler')
const { startPendingOutboundReconciliationScheduler } = require('./services/pendingOutboundReconciliationScheduler')
const { usuarioPodeVerGrupo } = require('./helpers/departamentoGruposHelper')
const { obterDepartamentoIdsDoUsuario } = require('./helpers/usuarioDepartamentosHelper')
const {
  empresaRoom,
  usuarioRoom,
  conversaRoom,
  departamentoRoom,
} = require('./helpers/socketRooms')

async function canUserJoinConversationRoom({ company_id, user_id, role, departamento_ids, conversa_id }) {
  const cid = Number(conversa_id)
  const companyId = Number(company_id)
  const userId = Number(user_id)
  if (!Number.isFinite(cid) || cid <= 0) return false
  if (!Number.isFinite(companyId) || companyId <= 0) return false
  if (!Number.isFinite(userId) || userId <= 0) return false

  const { data: conv, error: convErr } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone')
    .eq('company_id', companyId)
    .eq('id', cid)
    .maybeSingle()
  if (convErr || !conv) return false

  const profile = String(role || '').toLowerCase()
  if (profile === 'admin') return true

  const isGroup =
    ['grupo', 'group'].includes(String(conv.tipo || '').toLowerCase()) ||
    String(conv.telefone || '').toLowerCase().endsWith('@g.us')
  if (isGroup) {
    return usuarioPodeVerGrupo({
      company_id: companyId,
      conversa_id: cid,
      role,
      departamento_ids,
    })
  }

  if (conv.atendente_id != null && Number(conv.atendente_id) === userId) return true

  const { data: transferRow } = await supabase
    .from('atendimentos')
    .select('id')
    .eq('company_id', companyId)
    .eq('conversa_id', cid)
    .eq('de_usuario_id', userId)
    .eq('acao', 'transferiu')
    .limit(1)
    .maybeSingle()
  if (transferRow) return true

  const depIds = Array.isArray(departamento_ids) ? departamento_ids.map(Number).filter(Number.isFinite) : []
  const convDep = conv.departamento_id != null ? Number(conv.departamento_id) : null
  if (convDep == null) return true
  return depIds.some((d) => d === convDep)
}

async function marcarConversaLidaSocket({ company_id, user_id, role, departamento_ids, conversa_id }) {
  const cid = Number(conversa_id)
  const companyId = Number(company_id)
  const userId = Number(user_id)
  if (!Number.isFinite(cid) || cid <= 0) return false
  if (!Number.isFinite(companyId) || companyId <= 0) return false
  if (!Number.isFinite(userId) || userId <= 0) return false

  const allowed = await canUserJoinConversationRoom({
    company_id: companyId,
    user_id: userId,
    role,
    departamento_ids,
    conversa_id: cid,
  })
  if (!allowed) return false

  await Promise.all([
    supabase
      .from('conversa_unreads')
      .update({
        unread_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('conversa_id', cid)
      .eq('usuario_id', userId),
    supabase
      .from('conversas')
      .update({ lida: true })
      .eq('company_id', companyId)
      .eq('id', cid),
  ])
  return true
}

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      if (allowedSocketOrigins.includes(origin)) return cb(null, true)
      return cb(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 30000,
})

internalChatSocket.attach(io)

// =====================================================
// 🔐 middleware de autenticação do socket (MANTIDO)
// =====================================================
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    if (!token) {
      return next(new Error('Token não informado'))
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    // Multi-tenant estrito: company_id obrigatório no token
    const cid = Number(payload?.company_id)
    if (!Number.isFinite(cid) || cid <= 0) {
      console.error('[TENANT_INCONSISTENT] Socket token sem company_id válido', {
        user_id: payload?.id ?? null,
        company_id: payload?.company_id ?? null,
        ip: socket.handshake.address
      })
      return next(new Error('Tenant inválido'))
    }
    payload.company_id = cid
    const userId = Number(payload.id ?? payload.user_id)
    if ((!payload.id || !Number.isFinite(Number(payload.id))) && Number.isFinite(userId) && userId > 0) {
      payload.id = userId
    }
    // Revogação: usuário desativado não conecta no tempo real (mesmo critério do middleware auth HTTP).
    const { usuarioEstaAtivo } = require('./helpers/usuarioAtivoGuard')
    const ativo = await usuarioEstaAtivo(userId, cid)
    if (!ativo) {
      return next(new Error('Usuário inativo'))
    }
    const fallbackUser = { departamento_id: payload.departamento_id }
    if (Number.isFinite(userId) && userId > 0) {
      const depIds = await obterDepartamentoIdsDoUsuario(userId, cid, fallbackUser)
      payload.departamento_ids = depIds
      payload.departamento_id = depIds.length > 0 ? depIds[0] : null
    } else if (!Array.isArray(payload.departamento_ids)) {
      payload.departamento_ids = payload.departamento_id != null ? [Number(payload.departamento_id)] : []
    }
    socket.user = payload

    next()
  } catch (err) {
    next(new Error('Token inválido'))
  }
})

// =====================================================
// 🔥 EVENTOS DEFINITIVOS (CONTRATO SAAS)
// =====================================================
io.EVENTS = {
  NOVA_MENSAGEM: 'nova_mensagem',
  STATUS_MENSAGEM: 'status_mensagem',
  NOVA_CONVERSA: 'nova_conversa',
  CONVERSA_ATUALIZADA: 'conversa_atualizada',
  ATUALIZAR_CONVERSA: 'atualizar_conversa',
  CONTATO_ATUALIZADO: 'contato_atualizado',
  MENSAGENS_LIDAS: 'mensagens_lidas',
  TAG_ADICIONADA: 'tag_adicionada',
  TAG_REMOVIDA: 'tag_removida',
  CONVERSA_TRANSFERIDA: 'conversa_transferida',
  MENSAGEM_INTERNA_ATENDIMENTO: 'mensagem_interna_atendimento',
  CONVERSA_ENCERRADA: 'conversa_encerrada',
  CONVERSA_REABERTA: 'conversa_reaberta',
  CONVERSA_ATRIBUIDA: 'conversa_atribuida',
  CRM_LEAD_UPDATED: 'crm:lead_updated',
  CRM_KANBAN_REFRESH: 'crm:kanban_refresh'
}

// =====================================================
// 🔥 HELPERS PADRONIZADOS (SEM QUEBRAR NADA)
// =====================================================
io.emitEmpresa = (company_id, event, payload) => {
  if (!company_id || !event) return
  const room = empresaRoom(company_id)
  if (room) io.to(room).emit(event, payload)
}

io.emitConversa = (conversa_id, event, payload) => {
  if (!conversa_id || !event) return
  const room = conversaRoom(conversa_id)
  if (room) io.to(room).emit(event, payload)
}

io.emitUsuario = (usuario_id, event, payload) => {
  if (!usuario_id || !event) return
  const room = usuarioRoom(usuario_id)
  if (room) io.to(room).emit(event, payload)
}

io.emitDepartamento = (company_id, departamento_id, event, payload) => {
  if (!company_id || !departamento_id || !event) return
  const room = departamentoRoom(company_id, departamento_id)
  if (room) io.to(room).emit(event, payload)
}

// =====================================================
// 🔌 conexão socket (MANTIDO + MELHORADO)
// =====================================================
io.on('connection', (socket) => {
  const { id, company_id, departamento_ids = [], perfil } = socket.user

  internalChatSocket.handleConnection(socket)

  if (SOCKET_DEBUG) console.log(`🟢 Socket conectado | Usuário ${id} | Empresa ${company_id}`)

  // rooms padrão: empresa (admin vê tudo) e usuário
  const empRoom = empresaRoom(company_id)
  const userRoom = usuarioRoom(id)
  if (empRoom) socket.join(empRoom)
  if (userRoom) socket.join(userRoom)
  // rooms por setor: usuário entra em todos os departamentos que pertence (Comercial + Financeiro, etc.)
  const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
  depIds.forEach((depId) => {
    if (depId != null && Number.isFinite(Number(depId))) {
      const depRoom = departamentoRoom(company_id, depId)
      if (depRoom) socket.join(depRoom)
    }
  })

  // entrar na conversa (idempotente: evita join duplicado e log repetido)
  socket.on('join_conversa', async (conversaId) => {
    try {
      if (!conversaId) return
      if (!allowSocketEvent(socket.id, 'join_conversa')) return

      const convId = Number(conversaId)
      if (!Number.isFinite(convId) || convId <= 0) return

      const room = conversaRoom(convId)
      if (!room) return
      // Já na room: não reconsultar DB (reduz carga sob reconnect/spam)
      if (socket.rooms.has(room)) return

      const allowed = await canUserJoinConversationRoom({
        company_id,
        user_id: id,
        role: perfil,
        departamento_ids,
        conversa_id: convId
      })
      if (!allowed) {
        console.warn(`[SOCKET_JOIN_DENIED] Usuario ${id} | Empresa ${company_id} | Conversa ${convId}`)
        return
      }

      socket.join(room)
      if (SOCKET_DEBUG) console.log(`[SOCKET_JOIN_CONVERSA] Usuario ${id} entrou na conversa ${convId}`)
    } catch (err) {
      console.error('[SOCKET_JOIN_CONVERSA]', {
        user_id: id,
        company_id,
        conversa_id: conversaId,
        message: err?.message || String(err || ''),
      })
    }
  })

  // sair da conversa (escala / limpeza de rooms)
  socket.on('leave_conversa', (conversaId) => {
    if (!conversaId) return

    const room = conversaRoom(conversaId)
    if (room) socket.leave(room)
    if (SOCKET_DEBUG) console.log(`💬 Socket saiu da conversa ${conversaId}`)
  })

  // =====================================================
  // Indicador de digitação (typing) — re-broadcast na room da conversa
  // =====================================================
  socket.on('typing_start', (data) => {
    if (!allowSocketEvent(socket.id, 'typing')) return
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    const room = conversaRoom(conversa_id)
    if (!room) return
    if (!socket.rooms.has(room)) return
    const payload = {
      conversa_id: Number(conversa_id),
      usuario_id: socket.user.id,
      nome: data?.nome ?? null
    }
    socket.to(room).emit('typing_start', payload)
  })

  socket.on('typing_stop', (data) => {
    if (!allowSocketEvent(socket.id, 'typing')) return
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    const room = conversaRoom(conversa_id)
    if (!room) return
    if (!socket.rooms.has(room)) return
    socket.to(room).emit('typing_stop', { conversa_id: Number(conversa_id) })
  })

  socket.on('marcar_conversa_lida', async (data = {}) => {
    if (!allowSocketEvent(socket.id, 'marcar_conversa_lida')) return
    const conversa_id = data?.conversa_id ?? data?.id
    try {
      const ok = await marcarConversaLidaSocket({
        company_id,
        user_id: id,
        role: perfil,
        departamento_ids,
        conversa_id,
      })
      if (!ok) return
      socket.emit(io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', {
        conversa_id: Number(conversa_id),
        usuario_id: Number(id),
      })
    } catch (err) {
      console.error('[SOCKET_MARCAR_CONVERSA_LIDA]', {
        user_id: id,
        company_id,
        conversa_id,
        message: err?.message || String(err || ''),
      })
    }
  })

  socket.on('disconnect', () => {
    if (SOCKET_DEBUG) console.log(`🔴 Socket desconectado | Usuário ${id}`)
  })
})

// =====================================================
// deixa o io acessível nos controllers (MANTIDO)
// =====================================================
app.set('io', io)

const PORT = process.env.PORT || 3000
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor HTTP + WebSocket rodando na porta ${PORT}`)

  // Multi-tenant: webhooks UltraMsg configurados manualmente no painel (Instance Settings).
  // Não há mais instância única em ENV para configurar no startup.

  // Inicia worker de jobs (sync_contatos, sync_fotos, etc.) em background.
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID
  const backgroundJobsDisabled = getBooleanEnv('ZAPERP_DISABLE_BACKGROUND_JOBS', false)
  if (!isTest && !backgroundJobsDisabled) {
    const { startWorker } = require('./services/queueManager')
    startWorker(5000, io)
    console.log('[WORKER] Job worker iniciado (polling a cada 5s)')
    startAbsenceFinalizationScheduler()
    startAdminAtendimentoAlertaScheduler()
    startAtendimentoSemRespostaScheduler(io)
    startProdutosSyncScheduler()
    startPendingOutboundReconciliationScheduler(io)
    const { startOutboundMediaResendScheduler } = require('./services/outboundMediaResendScheduler')
    startOutboundMediaResendScheduler(io)
    const { startInboundMediaRetryScheduler } = require('./services/inboundMediaPersistenceService')
    startInboundMediaRetryScheduler(supabase, io)
    const { startInboundMediaBackfillSweepScheduler } = require('./services/inboundMediaBackfillService')
    startInboundMediaBackfillSweepScheduler(supabase, io)
  } else if (backgroundJobsDisabled) {
    console.log('[WORKER] Rotinas em background desativadas por ZAPERP_DISABLE_BACKGROUND_JOBS')
  }
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[SHUTDOWN] Recebido ${signal}. Encerrando servidor HTTP/WebSocket...`)
  try {
    io.close()
  } catch (e) {
    console.error('[SHUTDOWN] Erro ao fechar Socket.IO:', e?.message || e)
  }
  server.close((err) => {
    if (err) {
      console.error('[SHUTDOWN] Erro ao fechar servidor:', err?.message || err)
      process.exit(1)
    }
    console.log('[SHUTDOWN] Servidor encerrado com sucesso.')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('[SHUTDOWN] Timeout ao encerrar servidor. Forcando saida.')
    process.exit(1)
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000)).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED_REJECTION]', err?.message || err)
})
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err?.message || err)
  shutdown('uncaughtException')
})
