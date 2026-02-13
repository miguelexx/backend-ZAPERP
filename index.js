require('dotenv').config()
const http = require('http')
const app = require('./app')
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

const server = http.createServer(app)

const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      if (allowedOrigins.length === 0) return cb(null, true)
      if (allowedOrigins.includes(origin)) return cb(null, true)
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
  CONVERSA_ATUALIZADA: 'conversa_atualizada',
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
  const { id, company_id, departamento_id } = socket.user

  console.log(`🟢 Socket conectado | Usuário ${id} | Empresa ${company_id}`)

  // rooms padrão: empresa (admin vê tudo) e usuário
  socket.join(`empresa_${company_id}`)
  socket.join(`usuario_${id}`)
  // room por setor: apenas atendentes do setor recebem eventos do departamento
  if (departamento_id != null) {
    socket.join(`departamento_${departamento_id}`)
  }

  // entrar na conversa
  socket.on('join_conversa', (conversaId) => {
    if (!conversaId) return

    socket.join(`conversa_${conversaId}`)
    console.log(`💬 Socket entrou na conversa ${conversaId}`)
  })

  // 🔥 NOVO: sair da conversa (escala / limpeza de rooms)
  socket.on('leave_conversa', (conversaId) => {
    if (!conversaId) return

    socket.leave(`conversa_${conversaId}`)
    console.log(`💬 Socket saiu da conversa ${conversaId}`)
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
})
