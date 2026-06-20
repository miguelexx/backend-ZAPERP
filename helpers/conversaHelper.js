/**
 * Helper para detectar se uma conversa é de grupo.
 * Regras: remoteJid termina com "@g.us", ou isGroup === true, ou tipo === "grupo".
 *
 * @param {object} conversa - Objeto conversa (pode ter telefone, remoteJid, tipo, is_group)
 * @returns {boolean}
 */
function isGroupConversation(conversa) {
  if (!conversa) return false
  const jid = conversa.remoteJid ?? conversa.telefone ?? conversa.phone ?? ''
  if (String(jid).endsWith('@g.us')) return true
  if (conversa.isGroup === true) return true
  const tipo = String(conversa.tipo || '').toLowerCase()
  if (tipo === 'grupo' || tipo === 'group') return true
  return false
}

/** Status de atendimento encerrado (permite reabrir sem restrição de setor). */
function isClosedAttendanceStatus(status) {
  const s = String(status ?? '').toLowerCase().trim().replace(/\s+/g, '_')
  return s === 'fechada' || s === 'encerrada' || s === 'finalizada' || s === 'finalizado'
}

function isClosedAttendance(conversa) {
  if (!conversa) return false
  return isClosedAttendanceStatus(conversa.status_atendimento)
}

module.exports = { isGroupConversation, isClosedAttendanceStatus, isClosedAttendance }
