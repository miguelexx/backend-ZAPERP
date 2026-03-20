const path = require('path')
// Carrega .env do diretório do backend e SOBRESCREVE variáveis já existentes
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true })
const http = require('http')
const app = require('./app')
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

// Diagnóstico: em produção, logs mínimos (nunca expor tokens, senhas ou paths sensíveis)
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.join(__dirname, '.env')
  console.log('[ENV] Carregado:', envPath)
  console.log('APP_URL:', process.env.APP_URL || '(não definido)')
}
console.log('NODE_ENV:', process.env.NODE_ENV || 'development')

// Detecta NODE_ENV malformado (ex: falta newline no .env → NODE_ENV=productionULTRAMSG_BASE_URL=...)
const nodeEnv = String(process.env.NODE_ENV || '').trim()
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
const webhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN || process.env.ZAPI_WEBHOOK_TOKEN || ''
if (!String(webhookToken).trim()) {
  throw new Error('WHATSAPP_WEBHOOK_TOKEN não definido no .env')
}
if (!String(process.env.NODE_ENV || '').trim()) {
  throw new Error('NODE_ENV não definido no .env')
}

const server = http.createServer(app)

// CORS do Socket.IO: segue mesma política do Express (CORS_ORIGINS + APP_URL).
const allowedSocketOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let socketAppOrigin = null
try {
  const u = new URL(String(process.env.APP_URL || '').trim())
  socketAppOrigin = u?.origin || null
} catch (_) {
  socketAppOrigin = null
}

if (socketAppOrigin && !allowedSocketOrigins.includes(socketAppOrigin)) {
  allowedSocketOrigins.push(socketAppOrigin)
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
  transports: ['websocket', 'polling']
})

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
  CONVERSA_ENCERRADA: 'conversa_encerrada',
  CONVERSA_REABERTA: 'conversa_reaberta',
  CONVERSA_ATRIBUIDA: 'conversa_atribuida'
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
  const { id, company_id, departamento_ids = [] } = socket.user

  console.log(`🟢 Socket conectado | Usuário ${id} | Empresa ${company_id}`)

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
  socket.on('join_conversa', (conversaId) => {
    if (!conversaId) return

    const room = `conversa_${conversaId}`
    if (!socket.rooms.has(room)) {
      socket.join(room)
      console.log(`💬 Socket entrou na conversa ${conversaId}`)
      // Sincroniza contato com API UltraMsg ao abrir chat (atualiza nome/foto se necessário)
      setImmediate(() => {
        const supabase = require('./config/supabase')
        const { syncConversationContactOnJoin } = require('./services/ultramsgSyncContact')
        syncConversationContactOnJoin(supabase, Number(conversaId), company_id, io, { skipIfRecent: true }).catch(() => {})
      })
    }
  })

  // 🔥 NOVO: sair da conversa (escala / limpeza de rooms)
  socket.on('leave_conversa', (conversaId) => {
    if (!conversaId) return

    socket.leave(`conversa_${conversaId}`)
    console.log(`💬 Socket saiu da conversa ${conversaId}`)
  })

  // =====================================================
  // Indicador de digitação (typing) — re-broadcast na room da conversa
  // =====================================================
  socket.on('typing_start', (data) => {
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    const payload = {
      conversa_id: Number(conversa_id),
      usuario_id: socket.user.id,
      nome: data?.nome ?? null
    }
    socket.to(`conversa_${conversa_id}`).emit('typing_start', payload)
  })

  socket.on('typing_stop', (data) => {
    const conversa_id = data?.conversa_id
    if (!conversa_id) return
    socket.to(`conversa_${conversa_id}`).emit('typing_stop', { conversa_id: Number(conversa_id) })
  })

  socket.on('disconnect', () => {
    console.log(`🔴 Socket desconectado | Usuário ${id}`)
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
})
