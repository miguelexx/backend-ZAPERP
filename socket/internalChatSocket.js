/**
 * Socket.IO — chat interno (salas e eventos isolados do atendimento WhatsApp).
 */

const presence = require('./internalChatPresence')

const INTERNAL_CHAT_EVENTS = {
  CONVERSATION_CREATED: 'internal_chat:conversation_created',
  MESSAGE_CREATED: 'internal_chat:message_created',
  CONVERSATION_READ: 'internal_chat:conversation_read',
}

/**
 * @param {import('socket.io').Server} io
 */
function attach(io) {
  io.INTERNAL_CHAT_EVENTS = INTERNAL_CHAT_EVENTS

  /**
   * @param {number|string} userId
   * @param {string} event
   * @param {object} payload
   */
  io.internalChatEmitUser = (userId, event, payload) => {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0 || !event) return
    io.to(`internal_user_${uid}`).emit(event, payload)
  }

  /**
   * @param {Array<number|string>} userIds
   * @param {string} event
   * @param {object} payload
   */
  io.internalChatEmitUsers = (userIds, event, payload) => {
    const uniq = [...new Set((userIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
    for (const uid of uniq) {
      io.internalChatEmitUser(uid, event, payload)
    }
  }
}

/**
 * @param {import('socket.io').Socket} socket
 */
function handleConnection(socket) {
  const uid = Number(socket.user?.id)
  if (!Number.isFinite(uid) || uid <= 0) return

  socket.join(`internal_user_${uid}`)
  presence.registerConnect(uid)

  socket.on('disconnect', () => {
    presence.registerDisconnect(uid)
  })
}

module.exports = {
  INTERNAL_CHAT_EVENTS,
  attach,
  handleConnection,
}
