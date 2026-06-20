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

module.exports = { isGroupConversation }
