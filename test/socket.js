const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

module.exports = function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  // =====================================================
  // 🔐 AUTH JWT SOCKET
  // =====================================================
  io.use((socket, next) => {
    try {
      const token = socket.handshake?.auth?.token;
      if (!token) return next(new Error("Socket sem token"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (!decoded.company_id) {
        return next(new Error("Token sem company_id"));
      }

      socket.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        company_id: decoded.company_id,
      };

      next();
    } catch (err) {
      console.error("❌ Erro auth socket:", err.message);
      next(new Error("Token inválido no socket"));
    }
  });

  // =====================================================
  // 🔌 CONEXÃO
  // =====================================================
  io.on("connection", (socket) => {
    const { id, company_id } = socket.user;

    console.log(`🟢 Socket conectado | Usuário ${id} | Empresa ${company_id}`);

    // =====================================================
    // 🧩 ROOMS PADRÃO
    // =====================================================
    socket.join(`empresa_${company_id}`);
    socket.join(`usuario_${id}`);

    // =====================================================
    // 💬 ENTRAR EM CONVERSA
    // =====================================================
    socket.on("join_conversa", (conversaId) => {
      if (!conversaId) return;

      socket.join(`conversa_${conversaId}`);
      console.log(`💬 Socket entrou na conversa ${conversaId}`);
    });

    // =====================================================
    // 💬 SAIR DE CONVERSA
    // =====================================================
    socket.on("leave_conversa", (conversaId) => {
      if (!conversaId) return;

      socket.leave(`conversa_${conversaId}`);
      console.log(`💬 Socket saiu da conversa ${conversaId}`);
    });

    // =====================================================
    // 🔴 DISCONNECT
    // =====================================================
    socket.on("disconnect", () => {
      console.log(`🔴 Socket desconectado | Usuário ${id}`);
    });
  });

  // =====================================================
  // 🔥 HELPERS PADRONIZADOS — CONTRATO SAAS
  // 👉 usar SOMENTE estes no backend
  // =====================================================

  /**
   * Emite para toda a empresa
   */
  io.emitEmpresa = (company_id, event, payload) => {
    if (!company_id || !event) return;
    io.to(`empresa_${company_id}`).emit(event, payload);
  };

  /**
   * Emite para uma conversa específica
   */
  io.emitConversa = (conversa_id, event, payload) => {
    if (!conversa_id || !event) return;
    io.to(`conversa_${conversa_id}`).emit(event, payload);
  };

  /**
   * Emite para um usuário específico
   */
  io.emitUsuario = (usuario_id, event, payload) => {
    if (!usuario_id || !event) return;
    io.to(`usuario_${usuario_id}`).emit(event, payload);
  };

  // =====================================================
  // 📜 EVENTOS OFICIAIS DO SISTEMA (CONTRATO FRONTEND)
  // 👉 nunca renomear
  // =====================================================
  io.EVENTS = {
    NOVA_MENSAGEM: "nova_mensagem",
    CONVERSA_ATUALIZADA: "conversa_atualizada",
    MENSAGENS_LIDAS: "mensagens_lidas",
    TAG_ADICIONADA: "tag_adicionada",
    TAG_REMOVIDA: "tag_removida",
    CONVERSA_TRANSFERIDA: "conversa_transferida",
    CONVERSA_ENCERRADA: "conversa_encerrada",
    CONVERSA_REABERTA: "conversa_reaberta",
    CONVERSA_ATRIBUIDA: "conversa_atribuida",

    // ⭐ NOVO — SEMANA 3 (concorrência)
    CONVERSA_LOCK: "conversa_lock",
  };

  return io;
};
