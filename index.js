const path = require('path')
const { loadEnv, getBooleanEnv } = require('./config/env')
loadEnv()
const http = require('http')
const app = require('./app')
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const supabase = require('./config/supabase')
const { isOriginAllowed } = require('./helpers/corsOrigins')

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

const internalChatSocket = require('./socket/internalChatSocket')
const { startAbsenceFinalizationScheduler } = require('./services/absenceFinalizationScheduler')
const { startAdminAtendimentoAlertaScheduler } = require('./services/adminAtendimentoAlertaScheduler')
const { startAtendimentoSemRespostaScheduler } = require('./services/atendimentoSemRespostaScheduler')
const { startProdutosSyncScheduler } = require('./services/produtosSyncScheduler')
const { startPendingOutboundReconciliationScheduler } = require('./services/pendingOutboundReconciliationScheduler')
const { startTriageRedirectScheduler } = require('./services/triageRedirectScheduler')
const { usuarioPodeVerGrupo } = require('./helpers/departamentoGruposHelper')

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
      if (isOriginAllowed(origin)) return cb(null, true)
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
io.use((socket, next) => {
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
    if (!Array.isArray(payload.departamento_ids)) {
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
  io.to(`empresa_${company_id}`).emit(event, payload)
}

io.emitConversa = (conversa_id, event, payload) => {
  if (!conversa_id || !event) return
  io.to(`conversa_${conversa_id}`).emit(event, payload)
}

io.emitUsuario = (usuario_id, event, payload) => {
  if (!usuario_id || !event) return
  io.to(`usuario_${usuario_id}`).emit(event, payload)
}

// =====================================================
// 🔌 conexão socket (MANTIDO + MELHORADO)
// =====================================================
io.on('connection', (socket) => {
  const { id, company_id, departamento_ids = [], perfil } = socket.user

  internalChatSocket.handleConnection(socket)

  if (SOCKET_DEBUG) console.log(`🟢 Socket conectado | Usuário ${id} | Empresa ${company_id}`)

  // rooms padrão: empresa (admin vê tudo) e usuário
  socket.join(`empresa_${company_id}`)
  socket.join(`usuario_${id}`)
  // rooms por setor: usuário entra em todos os departamentos que pertence (Comercial + Financeiro, etc.)
  const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
  depIds.forEach((depId) => {
    if (depId != null && Number.isFinite(Number(depId))) {
      socket.join(`departamento_${depId}`)
    }
  })

  // entrar na conversa (idempotente: evita join duplicado e log repetido)
  socket.on('join_conversa', async (conversaId) => {
    try {
      if (!conversaId) return

      const convId = Number(conversaId)
      if (!Number.isFinite(convId) || convId <= 0) return

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

      const room = `conversa_${convId}`
      if (!socket.rooms.has(room)) {
        socket.join(room)
        if (SOCKET_DEBUG) console.log(`[SOCKET_JOIN_CONVERSA] Usuario ${id} entrou na conversa ${convId}`)
      }
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

    socket.leave(`conversa_${conversaId}`)
    if (SOCKET_DEBUG) console.log(`💬 Socket saiu da conversa ${conversaId}`)
  })

  // =====================================================
  // Indicador de digitação (typing) — re-broadcast na room da conversa
  // =====================================================
  socket.on('typing_start', (data) => {
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    const room = `conversa_${conversa_id}`
    if (!socket.rooms.has(room)) return
    const payload = {
      conversa_id: Number(conversa_id),
      usuario_id: socket.user.id,
      nome: data?.nome ?? null
    }
    socket.to(room).emit('typing_start', payload)
  })

  socket.on('typing_stop', (data) => {
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    const room = `conversa_${conversa_id}`
    if (!socket.rooms.has(room)) return
    socket.to(room).emit('typing_stop', { conversa_id: Number(conversa_id) })
  })

  socket.on('marcar_conversa_lida', async (data = {}) => {
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
    startTriageRedirectScheduler(io)
    const {
      startInboundMediaRetryScheduler,
      startInboundMediaDueRetryScheduler,
    } = require('./services/inboundMediaPersistenceService')
    startInboundMediaRetryScheduler(supabase, io)
    startInboundMediaDueRetryScheduler(supabase, io)
    // Espelhamento de mídia para Cloudflare R2 (rollout por empresa; default só company 1).
    // No-op se o R2 não estiver configurado no .env — o fluxo em disco permanece intacto.
    const { startMediaR2MirrorScheduler } = require('./services/mediaR2MirrorService')
    startMediaR2MirrorScheduler(supabase, io)
    // Retenção de mídia: apaga o ARQUIVO após MEDIA_RETENTION_DAYS (mantém a mensagem).
    // No-op se MEDIA_RETENTION_DAYS<=0 (padrão) ou R2 desligado. Escopo = empresas em R2.
    const { startMediaRetentionScheduler } = require('./services/mediaRetentionService')
    startMediaRetentionScheduler(supabase)
  } else if (backgroundJobsDisabled) {
    console.log('[WORKER] Rotinas em background desativadas por ZAPERP_DISABLE_BACKGROUND_JOBS')
  }

  // Log de diagnóstico SEMPRE no arranque: confirma que este código está rodando e o estado do R2.
  if (!isTest) {
    try {
      const { isR2Configured } = require('./config/r2')
      console.log('[mediaR2] boot:', {
        migrar_historico: String(process.env.R2_MIGRATE_HISTORICO_ON_BOOT || '(off)').trim(),
        r2_configurado: isR2Configured(),
      })
    } catch (e) { console.warn('[mediaR2] boot log falhou:', e?.message || e) }
  }

  // Migração ÚNICA do histórico de mídia para o R2, disparada por env (R2_MIGRATE_HISTORICO_ON_BOOT=1).
  // Roda mesmo com as rotinas de background desativadas. É idempotente: depois que migrar tudo,
  // desligue a env. Não bloqueia o boot (setImmediate) e não afeta outras empresas.
  if (!isTest && String(process.env.R2_MIGRATE_HISTORICO_ON_BOOT || '').trim() === '1') {
    const { runFullHistoryMigration } = require('./services/mediaR2MirrorService')
    console.log('[mediaR2/historico] R2_MIGRATE_HISTORICO_ON_BOOT=1 — agendando migração completa do histórico.')
    setImmediate(() => {
      runFullHistoryMigration(supabase, io).catch((e) => {
        console.error('[mediaR2/historico] falha:', e?.message || e)
      })
    })
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
