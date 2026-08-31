/**
 * Quatro APIs de JID — NÃO unificar.
 *
 * 1. Envio: toUltramsgPhone / phoneCandidatesForSend / phoneToChatId
 *    (toZapiSendFormat insere o 9º dígito em celular BR)
 * 2. Foto/metadados: toLookupChatId / profilePictureChatIdCandidates
 *    (JID real; nunca toZapiSendFormat)
 * 3. Histórico /chats/messages: chatMessageCandidatesForLookup
 *    (com 9 E JID cru de 12 dígitos)
 * 4. normalizePhone / phoneCandidatesForLookup — match/dedup (possiblePhonesBR)
 */

const {
  normalizePhoneBR,
  toZapiSendFormat,
  preferredBrSendDigits,
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  isSameWhatsappIdentity,
  extractPhoneFromChatId,
} = require('../../../helpers/phoneHelper')

/**
 * Converte número para formato UltraMsg: +5511986459364 (13 dígitos BR), 120...@g.us ou {Group}-{Owner}@g.us.
 * UltraMsg exige DDI 55 completo. Prioriza normalizePhoneBR + toZapiSendFormat para garantir 13 dígitos (celular).
 */
function toUltramsgPhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return s.replace(/-group$/, '') + '@g.us'
  // Formato UltraMsg Group-Owner sem sufixo (ex: 3618420-5534984080098)
  if (/^\d{5,15}-\d{10,15}$/.test(s)) return `${s}@g.us`
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  // Normaliza BR (55 + DDD + número) e garante 13 dígitos para celular (toZapiSendFormat insere 9 se 12)
  const norm = normalizePhoneBR(s)
  const fmt = toZapiSendFormat(norm || digits) || (digits.startsWith('55') ? digits : '55' + digits)
  return fmt ? `+${fmt}` : ''
}

/** Candidatos de telefone para envio (individual e grupo). */
function phoneCandidatesForSend(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return []
  const list = []
  const pushPhoneDigits = (value) => {
    const digits = String(value || '').replace(/\D/g, '')
    if (!digits || digits.startsWith('120')) return
    list.push(`+${digits}`)
  }
  // nums[0] é o ÚNICO candidato realmente usado no envio (body.to). Para celular BR
  // guardado sem o nono dígito (55+DDD+8, local começando em 6-9), o WhatsApp exige o
  // 9 — mandar sem ele cai em "número não existe" e a mensagem falha. `possiblePhonesBR`
  // é para match/dedup (não envio) e lista o número cru primeiro, o que empurrava o
  // formato correto para trás. Aqui o formato de envio ciente de celular/fixo vem primeiro.
  const preferred = preferredBrSendDigits(raw)
  if (preferred) list.push(`+${preferred}`)
  const norm = normalizePhoneBR(raw)
  for (const candidate of possiblePhonesBR(norm || raw)) {
    pushPhoneDigits(candidate)
  }
  const main = toUltramsgPhone(raw)
  if (main) list.push(main)
  if (raw.endsWith('@g.us') && main && !main.includes('@')) list.push(raw)
  if (raw.includes('-group')) list.push(raw.replace(/-group$/, '') + '@g.us')
  return Array.from(new Set(list.filter(Boolean)))
}

/** Normaliza telefone (interface compatível com zapi). */
function normalizePhone(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return s
  return normalizePhoneBR(s)
}

function phoneCandidatesForLookup(phone) {
  const norm = normalizePhone(phone)
  const candidates = possiblePhonesBR(norm)
  const sendFmt = toZapiSendFormat(norm)
  if (sendFmt) candidates.push(sendFmt)
  return Array.from(new Set(candidates.filter(Boolean)))
}

function pushUniqueValue(list, value) {
  const raw = String(value || '').trim()
  if (raw && !list.includes(raw)) list.push(raw)
}

/**
 * Converte phone para chatId no formato WhatsApp: 5511986459364@c.us (13 dígitos BR) ou 120xxx@g.us.
 * UltraMsg exige chatId sem + e sem espaços.
 * ATENÇÃO: insere o 9º dígito (formato de ENVIO). Não usar para foto/metadados.
 */
function phoneToChatId(phone) {
  const s = String(phone || '').trim()
  if (!s) return null
  if (s.endsWith('@g.us')) return s
  if (s.endsWith('@c.us')) return s
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  const norm = normalizePhoneBR(s)
  const fmt = toZapiSendFormat(norm || digits) || (digits.startsWith('55') ? digits : '55' + digits)
  return fmt ? `${fmt}@c.us` : null
}

/** Resolve phone/chatId para chatId no formato @c.us ou @g.us (exigido por chats/*). */
function toChatIdForChats(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  if (s.includes('-group')) return (s.replace(/-group$/, '') || s) + '@g.us'
  return phoneToChatId(s) || ''
}

/**
 * chatId para CONSULTA (foto/metadados) — NÃO usa toZapiSendFormat.
 * Forçar o 9º dígito busca outro JID e grava a foto no contato errado.
 */
function toLookupChatId(phoneOrChatId) {
  const s = String(phoneOrChatId || '').trim()
  if (!s) return null
  if (s.endsWith('@g.us')) return s
  if (s.endsWith('@c.us')) return s
  if (s.includes('-group')) return `${s.replace(/-group$/, '')}@g.us`
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('120') && digits.length >= 15) return `${digits}@g.us`
  return `${digits}@c.us`
}

/**
 * Candidatos de chatId para GET /contacts/image.
 * JID explícito (webhook): só ele.
 * Telefone armazenado: dígitos reais + variante celular 12↔13 (nunca fixo+9).
 */
function profilePictureChatIdCandidates(phoneOrChatId, opts = {}) {
  const candidates = []
  const push = (value) => {
    const chatId = toLookupChatId(value)
    if (chatId && !candidates.includes(chatId)) candidates.push(chatId)
  }

  const explicit = opts.chatId != null ? String(opts.chatId).trim() : ''
  if (explicit) {
    push(explicit)
    return candidates
  }

  const raw = String(phoneOrChatId || '').trim()
  if (!raw) return candidates
  if (raw.endsWith('@g.us') || raw.includes('-group')) {
    push(raw)
    return candidates
  }

  push(raw)
  for (const variant of possiblePhonesForWhatsappIdentity(raw)) {
    push(variant)
  }
  return candidates
}

function contactRecordMatchesChatId(data, chatId) {
  if (!data || typeof data !== 'object') return { hasIdentity: false, matched: false }
  const requested = extractPhoneFromChatId(chatId) || String(chatId || '').replace(/\D/g, '')
  const ids = [data.id, data.phone, data.wa_id, data.jid, data.chatId, data.from]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
  if (!requested || ids.length === 0) return { hasIdentity: false, matched: false }
  for (const id of ids) {
    const digits = extractPhoneFromChatId(id) || String(id).replace(/\D/g, '')
    if (isSameWhatsappIdentity(digits || id, requested)) {
      return { hasIdentity: true, matched: true }
    }
  }
  return { hasIdentity: true, matched: false }
}

function chatMessageCandidatesForLookup(phone, opts = {}) {
  const values = [phone]
  if (Array.isArray(opts.chatIdCandidates)) values.push(...opts.chatIdCandidates)

  const candidates = []
  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw) continue

    if (raw.endsWith('@g.us') || raw.endsWith('@c.us')) pushUniqueValue(candidates, raw)
    if (/@s\.whatsapp\.net$/i.test(raw)) {
      pushUniqueValue(candidates, raw.replace(/@s\.whatsapp\.net$/i, '@c.us'))
    }

    pushUniqueValue(candidates, toChatIdForChats(raw) || phoneToChatId(raw))
    for (const candidate of phoneCandidatesForLookup(raw)) {
      pushUniqueValue(candidates, phoneToChatId(candidate))
      // JID cru, sem forçar o nono dígito: o WhatsApp/UltraMSG guardam muitos números BR
      // de celular no formato de 12 dígitos (55 + DDD + 8), SEM o "9". phoneToChatId sempre
      // reinsere o 9 (é o formato de ENVIO, via toZapiSendFormat), então o JID de 12 dígitos
      // nunca era consultado e /chats/messages devolvia vazio → falso "nenhuma mensagem antiga".
      // possiblePhonesBR já entrega as duas variantes (com e sem 9); tentamos ambas como @c.us.
      const candDigits = String(candidate || '').replace(/\D/g, '')
      if (candDigits && !candDigits.startsWith('120')) {
        pushUniqueValue(candidates, `${candDigits}@c.us`)
      }
    }
  }

  return candidates.filter(Boolean)
}

/** Normaliza phone/chatId para formato UltraMsg: +55... ou xxx@g.us */
function normalizeChatId(phoneOrChatId) {
  return toUltramsgPhone(phoneOrChatId) || phoneToChatId(phoneOrChatId) || ''
}

module.exports = {
  toUltramsgPhone,
  phoneCandidatesForSend,
  normalizePhone,
  phoneCandidatesForLookup,
  phoneToChatId,
  toChatIdForChats,
  toLookupChatId,
  profilePictureChatIdCandidates,
  contactRecordMatchesChatId,
  chatMessageCandidatesForLookup,
  normalizeChatId,
}
