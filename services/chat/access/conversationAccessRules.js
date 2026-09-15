/**
 * Regras puras de visibilidade: perfil atendente não vê conversa individual
 * assumida por outro (ainda em atendimento). Admin/supervisor, grupos e
 * encerradas ficam de fora desta restrição — participantes/transferência
 * são tratados pelos callers antes de aplicar o corte.
 */

const { isGroupConversation, isClosedAttendanceStatus } = require('../../../helpers/conversaHelper')

function isPerfilAtendente(role) {
  return String(role || '').toLowerCase() === 'atendente'
}

function conversaAssumidaAtivaPorOutro(conv, user_id) {
  if (!conv || isGroupConversation(conv)) return false
  if (isClosedAttendanceStatus(conv.status_atendimento)) return false
  if (conv.atendente_id == null) return false
  return Number(conv.atendente_id) !== Number(user_id)
}

function atendenteNaoPodeVerAssumidaPorOutro({ role, userId, conv }) {
  return isPerfilAtendente(role) && conversaAssumidaAtivaPorOutro(conv, userId)
}

module.exports = {
  isPerfilAtendente,
  conversaAssumidaAtivaPorOutro,
  atendenteNaoPodeVerAssumidaPorOutro,
}
