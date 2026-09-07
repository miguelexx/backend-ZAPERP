/**
 * Stubs Whapi restantes (métodos UltraMSG-only sem equivalente estável).
 * Consultas reais estão em contacts.js / chatsAdmin.js / chatMessages.js / messages.js.
 */

const { notImplemented } = require('./parse')

function stub(method) {
  return async () => notImplemented(method)
}

module.exports = {
  resendByStatus: stub('resendByStatus'),
  resendById: stub('resendById'),
  clearMessages: stub('clearMessages'),
  getMessagesStatistics: stub('getMessagesStatistics'),
}
