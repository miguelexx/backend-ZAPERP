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

const {
  normalizePhoneBR,
  preferredBrSendDigits,
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  isLidPhoneKey,
} = require('../../../helpers/phoneHelper')

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
 * Chat IDs para o botão "Buscar histórico".
 * A Whapi guarda o chat na forma canônica (muitas vezes BR de 12 dígitos, sem o 9).
 * `toWhapiChatId` sozinho reinsere o 9º e a lista volta vazia. Aqui tentamos a forma
 * crua e a variante com/sem 9, sem repetir.
 */
function historyChatIdCandidates(phone, extraSeeds = []) {
  const seeds = []
  const addSeed = (value) => {
    const raw = String(value || '').trim()
    if (!raw || seeds.includes(raw)) return
    seeds.push(raw)
  }
  addSeed(phone)
  if (Array.isArray(extraSeeds)) {
    for (const seed of extraSeeds) addSeed(seed)
  }

  const ids = []
  const addId = (id) => {
    const raw = String(id || '').trim()
    if (!raw || ids.includes(raw)) return
    if (ids.length >= 8) return
    ids.push(raw)
  }

  for (const seed of seeds) {
    if (isGroupJid(seed) || looksLikeStoredGroupId(seed)) {
      addId(toWhapiGroupId(seed))
      continue
    }
    const lid = toWhapiLidId(seed)
    if (lid) {
      addId(lid)
      continue
    }
    const explicit = explicitPrivateJidDigits(seed)
    if (explicit) addId(`${explicit}@s.whatsapp.net`)
    const bare = String(seed).replace(/@[^@]+$/, '').replace(/\D/g, '')
    if (bare && !bare.startsWith('120')) addId(`${bare}@s.whatsapp.net`)
    for (const variant of possiblePhonesBR(seed)) {
      const digits = String(variant || '').replace(/\D/g, '')
      if (digits) addId(`${digits}@s.whatsapp.net`)
    }
    addId(toWhapiChatId(seed))
  }

  return ids
}

/**
 * Chat IDs para AÇÕES de chat (apagar, arquivar, marcar lido…), na ordem de tentativa.
 *
 * Mesmo problema do botão "Buscar histórico", agora medido no canal de produção (20/10):
 * o chat vive na Whapi na forma que o WhatsApp usa — para celular BR quase sempre os
 * **12 dígitos, sem o 9º**. `toWhapiChatId` passa por `preferredBrSendDigits`, que INSERE o 9º,
 * e o endereço resultante não existe:
 *
 *   GET /chats/553493120506@s.whatsapp.net  → 200 (o chat real)
 *   GET /chats/5534993120506@s.whatsapp.net → 404 "specified chat not found"
 *
 * Como `DELETE /chats/{id}` em id inexistente é 404 e não apaga nada, apagar a conversa no
 * ZapERP não saía do WhatsApp. Aqui a forma CRUA vem primeiro (é a que o canal costuma ter) e
 * as variantes de ±9º dígito depois. Quem chama tenta em ordem e para no primeiro que não for 404.
 * Grupo e LID têm um endereço só — não variam.
 *
 * @param {string} phone telefone/JID como está em `conversas.telefone`
 * @param {number} [max=3] teto de tentativas (uma chamada HTTP por candidato)
 */
function chatIdCandidates(phone, max = 3) {
  const raw = String(phone ?? '').trim()
  if (!raw) return []
  if (isGroupJid(raw) || looksLikeStoredGroupId(raw)) {
    const groupId = toWhapiGroupId(raw)
    return groupId ? [groupId] : []
  }
  const lid = toWhapiLidId(raw)
  if (lid) return [lid]
  if (isLidPhoneKey(raw)) return []

  const ids = []
  const addId = (id) => {
    const v = String(id || '').trim()
    if (!v || ids.includes(v) || ids.length >= max) return
    ids.push(v)
  }
  // 1º a forma crua/explícita — é a que o canal tem na maioria dos casos.
  const explicit = explicitPrivateJidDigits(raw)
  if (explicit) addId(`${explicit}@s.whatsapp.net`)
  const bare = raw.replace(/@[^@]+$/, '').replace(/\D/g, '')
  if (bare && !bare.startsWith('120')) addId(`${bare}@s.whatsapp.net`)
  // Depois as variantes ±9º dígito e, por último, a forma preferida de envio.
  // `possiblePhonesForWhatsappIdentity` e NÃO `possiblePhonesBR`: só o primeiro tem a guarda de
  // celular (`isLikelyBrMobileDigits`). Sem ela, um FIXO como 553434238595 geraria o "celular"
  // 5534934238595 — e, como o `deleteChat` passou a agir em TODOS os endereços, um palpite que
  // por acaso exista seria a conversa de OUTRA pessoa sendo apagada. Em celular BR as duas
  // formas são o mesmo assinante; em fixo, não são.
  for (const variant of possiblePhonesForWhatsappIdentity(raw)) {
    const digits = String(variant || '').replace(/\D/g, '')
    if (digits) addId(`${digits}@s.whatsapp.net`)
  }
  addId(toWhapiChatId(raw))
  return ids
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
  historyChatIdCandidates,
  chatIdCandidates,
}
