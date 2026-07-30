const MESSAGE_TYPES = new Set(['texto', 'audio', 'imagem', 'video', 'documento', 'outros'])

function normalizeMessageType(value) {
  const raw = String(value || 'texto').trim().toLowerCase()
  if (['text', 'texto'].includes(raw)) return 'texto'
  if (['audio', 'áudio', 'ptt', 'voice'].includes(raw)) return 'audio'
  if (['image', 'imagem', 'photo', 'sticker', 'figurinha'].includes(raw)) return raw === 'sticker' || raw === 'figurinha' ? 'outros' : 'imagem'
  if (['video', 'vídeo'].includes(raw)) return 'video'
  if (['document', 'documento', 'file', 'arquivo', 'pdf'].includes(raw)) return 'documento'
  return MESSAGE_TYPES.has(raw) ? raw : 'outros'
}

function isWhatsappOperationalMessage(message) {
  if (!message || !['in', 'out'].includes(String(message.direcao || '').toLowerCase())) return false
  if (message.apagada_para_todos === true) return false
  if (message.interna === true || message.nota_interna === true) return false
  if (message.cancelada === true) return false
  return true
}

function messageStableKey(message) {
  const whatsappId = String(message?.whatsapp_id || '').trim()
  if (whatsappId) {
    return `wa:${message?.whatsapp_instance_id ?? 'legacy'}:${whatsappId}`
  }
  return message?.id != null ? `row:${message.id}` : null
}

function dedupeOperationalMessages(messages) {
  const seen = new Set()
  const rows = []
  let duplicateCount = 0
  let invalidCount = 0

  for (const message of messages || []) {
    if (!isWhatsappOperationalMessage(message)) {
      invalidCount += 1
      continue
    }
    const key = messageStableKey(message)
    if (key && seen.has(key)) {
      duplicateCount += 1
      continue
    }
    if (key) seen.add(key)
    rows.push(message)
  }

  return { rows, duplicateCount, invalidCount }
}

function explicitMessageOrigin(message) {
  const origin = String(message?.origem || '').trim().toLowerCase()
  if (origin) return origin
  if (message?.direcao === 'in') return 'cliente'
  if (message?.direcao === 'out' && Number(message?.autor_usuario_id) > 0) return 'sistema_humano'
  return 'desconhecida'
}

function isExplicitHumanOutbound(message) {
  if (!message || message.direcao !== 'out') return false
  const origin = explicitMessageOrigin(message)
  if (origin === 'sistema_humano' || origin === 'whatsapp_celular') return true
  if (origin === 'automacao' || origin === 'bot' || origin === 'campanha' || origin === 'sistema') return false
  return Number(message.autor_usuario_id) > 0
}

function isIndividualCustomerConversation(conversation) {
  if (!conversation) return false
  return String(conversation.tipo || '').toLowerCase() !== 'grupo'
    && !String(conversation.telefone || '').toLowerCase().includes('@g.us')
}

function summarizeDailyCustomerActivity({
  messages = [],
  conversations = [],
  todayKey,
  dateKeyFor,
} = {}) {
  const conversationById = new Map(
    (conversations || []).map((conversation) => [String(conversation.id), conversation])
  )
  const activeCustomers = new Set()
  const humanRespondedCustomers = new Set()

  for (const message of messages || []) {
    if (!message?.conversa_id || dateKeyFor?.(message.criado_em) !== todayKey) continue
    const conversation = conversationById.get(String(message.conversa_id))
    if (!conversation) continue
    if (!isIndividualCustomerConversation(conversation)) continue
    const customerKey = conversation.cliente_id
      ? `cliente:${conversation.cliente_id}`
      : `conversa:${message.conversa_id}`
    activeCustomers.add(customerKey)
    if (isExplicitHumanOutbound(message)) humanRespondedCustomers.add(customerKey)
  }

  return {
    clientes_com_conversa: activeCustomers.size,
    clientes_com_resposta_humana: humanRespondedCustomers.size,
  }
}

module.exports = {
  normalizeMessageType,
  isWhatsappOperationalMessage,
  messageStableKey,
  dedupeOperationalMessages,
  explicitMessageOrigin,
  isExplicitHumanOutbound,
  isIndividualCustomerConversation,
  summarizeDailyCustomerActivity,
}
