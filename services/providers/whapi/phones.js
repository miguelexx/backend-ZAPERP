/**
 * Regras de telefone/JID para Whapi. NÃO reusar as 4 APIs de JID da UltraMSG
 * (toUltramsgPhone / phoneToChatId / profilePictureChatIdCandidates / chatMessageCandidatesForLookup).
 *
 * Whapi `to` em /messages/text (CONFIRMADO OpenAPI + MCP sendMessageText):
 *   - privado: dígitos internacionais SEM '+' (ex. 5534999999999); sufixo
 *     `@s.whatsapp.net` é opcional (padrão `^\\d{7,15}(@(s\\.whatsapp.net|lid))?$`)
 *   - grupo:   JID '<...>@g.us' preservado
 * A normalização BR (inserção do 9º dígito quando falta) reusa helpers/phoneHelper,
 * a MESMA base da identidade WhatsApp — sem a mangueira de JID UltraMSG.
 */

const { normalizePhoneBR, preferredBrSendDigits } = require('../../../helpers/phoneHelper')

/** true se o valor já é um JID de grupo (@g.us). */
function isGroupJid(v) {
  return typeof v === 'string' && v.trim().toLowerCase().endsWith('@g.us')
}

/**
 * Candidatos de destino para envio, na ordem de preferência.
 * Grupo: devolve o JID cru. Privado BR: preferredBrSendDigits (ciente de celular vs fixo).
 * Fallback: dígitos crus.
 */
function recipientCandidates(phone) {
  if (phone == null) return []
  const raw = String(phone).trim()
  if (!raw) return []
  if (isGroupJid(raw)) return [raw]
  // Remove sufixo @s.whatsapp.net/@c.us se vier, e o '+'
  const bare = raw.replace(/@[^@]+$/, '').replace(/[^\d]/g, '')
  if (!bare) return []
  let candidates = []
  try {
    const pref = preferredBrSendDigits(bare)
    if (Array.isArray(pref) && pref.length) candidates = pref.map((d) => String(d).replace(/\D/g, '')).filter(Boolean)
  } catch { /* ignore */ }
  if (!candidates.length) {
    const norm = normalizePhoneBR(bare)
    candidates = [String(norm || bare).replace(/\D/g, '')].filter(Boolean)
  }
  // Dedup preservando ordem
  return [...new Set(candidates)]
}

/** Destino canônico (primeiro candidato) para o campo `to` do Whapi. */
function toWhapiRecipient(phone) {
  const c = recipientCandidates(phone)
  return c.length ? c[0] : ''
}

module.exports = {
  isGroupJid,
  recipientCandidates,
  toWhapiRecipient,
}
