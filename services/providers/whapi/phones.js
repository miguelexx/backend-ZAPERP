/**
 * Regras de telefone/JID para Whapi. NÃO reusar as 4 APIs de JID da UltraMSG
 * (toUltramsgPhone / phoneToChatId / profilePictureChatIdCandidates / chatMessageCandidatesForLookup).
 *
 * Whapi `to` em /messages/text (CONFIRMADO OpenAPI + MCP sendMessageText):
 *   - privado: dígitos internacionais SEM '+' (ex. 5534999999999); sufixo
 *     `@s.whatsapp.net` é opcional (padrão `^\\d{7,15}(@(s\\.whatsapp.net|lid))?$`)
 *   - grupo:   JID '<...>@g.us' (conversas.telefone de grupo costuma guardar só os dígitos 120…)
 *   - LID:     `<id>@lid` (nunca dígitos crus — @lid NÃO é telefone)
 * A normalização BR (inserção do 9º dígito quando falta) reusa helpers/phoneHelper,
 * a MESMA base da identidade WhatsApp — sem a mangueira de JID UltraMSG.
 */

const { normalizePhoneBR, preferredBrSendDigits, isLidPhoneKey } = require('../../../helpers/phoneHelper')

/** true se o valor já é um JID de grupo (@g.us). */
function isGroupJid(v) {
  return typeof v === 'string' && v.trim().toLowerCase().endsWith('@g.us')
}

/**
 * Grupo gravado no CRM: JID `@g.us`, formato UltraMSG `owner-group`, ou id 120… (15–40 dígitos).
 * NÃO tratar telefone privado (55…) como grupo.
 */
function looksLikeStoredGroupId(raw) {
  const s = String(raw || '').trim()
  if (!s) return false
  if (isGroupJid(s)) return true
  if (/^\d{5,15}-\d{10,15}$/.test(s)) return true
  const digits = s.replace(/@[^@]+$/, '').replace(/\D/g, '')
  return digits.startsWith('120') && digits.length >= 15 && digits.length <= 40
}

/** Chat ID LID Whapi (`…@lid`). Aceita `lid:xxx` (chave do CRM) ou JID cru. */
function toWhapiLidId(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('lid:')) {
    const id = raw.slice(4).trim()
    if (!id) return ''
    return id.includes('@') ? id : `${id}@lid`
  }
  if (lower.includes('@lid')) return raw
  return ''
}

/**
 * JID privado explicito vindo do WhatsApp/agenda. Os digitos deste identificador
 * sao canonicos: nao inserir/remover o nono digito depois de retirar o sufixo.
 */
function explicitPrivateJidDigits(phone) {
  const raw = String(phone || '').trim()
  const match = raw.match(/^(\d+)@(c\.us|s\.whatsapp\.net)$/i)
  return match ? match[1] : ''
}

/**
 * Group ID Whapi (`^[\\d-]{10,31}@g\\.us$`).
 * Aceita JID completo, dígitos 120… gravados em `conversas.telefone`, ou Group-Owner legado.
 * Recusa telefone privado / chave `lid:` / `grupo_` fake.
 */
function toWhapiGroupId(groupId) {
  const raw = String(groupId || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('grupo_') || lower.startsWith('comunidade_') || lower.startsWith('lid:')) return ''
  if (!looksLikeStoredGroupId(raw)) return ''
  if (isGroupJid(raw)) return raw
  const core = raw.replace(/@[^@]+$/, '').trim()
  if (/^[\d-]{10,40}$/.test(core)) return `${core}@g.us`
  const digits = core.replace(/\D/g, '')
  if (digits.length >= 10 && digits.length <= 40) return `${digits}@g.us`
  return ''
}

/**
 * Candidatos de destino para envio, na ordem de preferência.
 * Grupo: JID `@g.us`. LID: `@lid` (nunca dígitos). Privado BR: preferredBrSendDigits (string).
 */
function recipientCandidates(phone) {
  if (phone == null) return []
  const raw = String(phone).trim()
  if (!raw) return []
  if (isGroupJid(raw) || looksLikeStoredGroupId(raw)) {
    const groupId = toWhapiGroupId(raw)
    return groupId ? [groupId] : []
  }
  const lid = toWhapiLidId(raw)
  if (lid) return [lid]
  if (isLidPhoneKey(raw)) return []
  const explicitPrivate = explicitPrivateJidDigits(raw)
  if (explicitPrivate) return [explicitPrivate]
  // Remove sufixo @s.whatsapp.net/@c.us se vier, e o '+'
  const bare = raw.replace(/@[^@]+$/, '').replace(/[^\d]/g, '')
  if (!bare) return []
  const candidates = []
  try {
    // preferredBrSendDigits devolve STRING (dígitos), não array — Array.isArray nunca casava
    // e o fallback normalizePhoneBR deixava celular BR de 12 dígitos sem o 9º.
    const pref = preferredBrSendDigits(bare)
    if (pref) candidates.push(String(pref).replace(/\D/g, ''))
  } catch { /* ignore */ }
  if (!candidates.length) {
    const norm = normalizePhoneBR(bare)
    const digits = String(norm || bare).replace(/\D/g, '')
    if (digits) candidates.push(digits)
  }
  return [...new Set(candidates.filter(Boolean))]
}

/** Destino canônico (primeiro candidato) para o campo `to` do Whapi. */
function toWhapiRecipient(phone) {
  const c = recipientCandidates(phone)
  return c.length ? c[0] : ''
}

/**
 * Chat ID Whapi (OpenAPI: `^[\d-]{10,31}@[\w\.]+$`).
 * Grupo: JID `@g.us`. LID: `@lid`. Privado: dígitos + `@s.whatsapp.net`.
 */
function toWhapiChatId(phone) {
  if (phone == null) return ''
  const raw = String(phone).trim()
  if (!raw) return ''
  if (isGroupJid(raw) || looksLikeStoredGroupId(raw)) return toWhapiGroupId(raw) || raw
  const lid = toWhapiLidId(raw)
  if (lid) return lid
  const to = toWhapiRecipient(raw)
  if (!to) return ''
  if (isGroupJid(to) || to.includes('@')) return to
  return `${to}@s.whatsapp.net`
}

/**
 * Contact ID Whapi (OpenAPI: só dígitos `^[\d]{7,15}$`).
 * Grupo: devolve o JID (perfil de grupo não usa este endpoint). LID: vazio (não é ContactID).
 */
function toWhapiContactId(phone) {
  if (phone == null) return ''
  const raw = String(phone).trim()
  if (!raw) return ''
  if (isGroupJid(raw) || looksLikeStoredGroupId(raw)) return toWhapiGroupId(raw) || raw
  if (toWhapiLidId(raw) || isLidPhoneKey(raw)) return ''
  const digits = raw.replace(/@[^@]+$/, '').replace(/\D/g, '')
  return digits
}

module.exports = {
  isGroupJid,
  looksLikeStoredGroupId,
  toWhapiLidId,
  explicitPrivateJidDigits,
  toWhapiGroupId,
  recipientCandidates,
  toWhapiRecipient,
  toWhapiChatId,
  toWhapiContactId,
}
