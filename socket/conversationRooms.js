/** Cancela joins cuja autorização terminou depois de leave/disconnect. */
function registerConversationRooms(socket, { canJoin, onError = console.error }) {
  const pending = new Map()
  const normalize = (id) => Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null
  socket.on('join_conversa', async (rawId) => {
    const id = normalize(rawId)
    if (!id) return
    const request = {}
    pending.set(id, request)
    try {
      const allowed = await canJoin(id)
      if (!allowed || !socket.connected) {
        if (pending.get(id) === request) pending.delete(id)
        return
      }
      if (pending.get(id) !== request) return
      const room = `conversa_${id}`
      if (!socket.rooms.has(room)) await socket.join(room)
      // Adaptadores assíncronos também podem terminar o join depois de leave.
      if (!socket.connected || (!pending.has(id))) await socket.leave(room)
    } catch (err) {
      if (pending.get(id) === request) pending.delete(id)
      onError('[SOCKET_JOIN_CONVERSA]', { conversa_id: id, message: err?.message || String(err) })
    }
  })
  socket.on('leave_conversa', (rawId) => {
    const id = normalize(rawId)
    if (!id) return
    pending.delete(id)
    Promise.resolve(socket.leave(`conversa_${id}`)).catch(onError)
  })
  socket.on('disconnect', () => pending.clear())
}

module.exports = { registerConversationRooms }
