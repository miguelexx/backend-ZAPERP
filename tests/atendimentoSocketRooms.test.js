const { registerConversationRooms } = require('../socket/conversationRooms')
function setup() {
  const handlers = {}, requests = []
  const socket = { connected: true, rooms: new Set(), on: (event, cb) => { handlers[event] = cb },
    join: jest.fn(async room => socket.rooms.add(room)), leave: jest.fn(async room => socket.rooms.delete(room)) }
  const onError = jest.fn()
  registerConversationRooms(socket, { canJoin: () => new Promise(resolve => requests.push(resolve)), onError })
  return { socket, handlers, requests, onError }
}
test('leave durante autorização impede join atrasado', async () => {
  const { socket, handlers, requests } = setup()
  const pending = handlers.join_conversa(1)
  handlers.leave_conversa(1); requests.shift()(true); await pending
  expect(socket.join).not.toHaveBeenCalled()
})
test('A→B→A aceita somente autorização mais recente de A', async () => {
  const { socket, handlers, requests } = setup()
  const old = handlers.join_conversa(1); handlers.leave_conversa(1)
  const current = handlers.join_conversa(1)
  requests[1](true); await current
  requests[0](true); await old
  expect(socket.join).toHaveBeenCalledTimes(1)
  expect(socket.rooms.has('conversa_1')).toBe(true)
})
test('disconnect impede entrada depois da consulta', async () => {
  const { socket, handlers, requests } = setup()
  const pending = handlers.join_conversa(1)
  socket.connected = false; handlers.disconnect(); requests[0](true); await pending
  expect(socket.join).not.toHaveBeenCalled()
})
test('autorização negada e ID inválido não entram na sala', async () => {
  const { socket, handlers, requests } = setup()
  await handlers.join_conversa('1.5')
  expect(requests).toHaveLength(0)
  const pending = handlers.join_conversa(1); requests[0](false); await pending
  expect(socket.join).not.toHaveBeenCalled()
})
test('leave também vence adaptador com join assíncrono', async () => {
  const { socket, handlers, requests } = setup()
  let finishJoin
  socket.join.mockImplementation(room => new Promise(resolve => { finishJoin = () => { socket.rooms.add(room); resolve() } }))
  const pending = handlers.join_conversa(1); requests[0](true); await Promise.resolve()
  handlers.leave_conversa(1); finishJoin(); await pending
  expect(socket.rooms.size).toBe(0)
})
