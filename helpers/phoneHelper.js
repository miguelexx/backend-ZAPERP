/**
 * Normalização de telefone para Brasil (Z-API / WhatsApp).
 * Regras: apenas dígitos; prefixo 55; 12–13 dígitos (55 + DDD + número).
 * Grupos: preservar JID com @g.us.
 */

/**
 * Normaliza telefone para padrão Brasil (armazenamento/consulta).
 * - Grupos: retorna o JID intacto (ex: 120363...@g.us).
 * - Individual: só dígitos; se 10 dígitos (DDD+8) adiciona 55 → 12; se 11 (DDD+9+8) adiciona 55 → 13.
 *
 * @param {string} phone - Número ou JID (ex: 3499999999, 5534999999999, 123@g.us)
 * @returns {string}
 */
function normalizePhoneBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''

  if (s.endsWith('@g.us')) return s

  const digits = s.replace(/\D/g, '')
  if (!digits) return ''

  // ✅ Grupo (WhatsApp): IDs geralmente começam com 120 e são longos (ex.: 1203630...).
  // Aceitar para não quebrar envio/roteamento quando o provider mandar só os dígitos.
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits

  // ✅ BR strict:
  // - já vem com DDI 55: 55 + DDD(2) + número (8/9) => 12/13
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
  // - às vezes vem só DDD+numero (10/11)
  if (digits.length === 10 || digits.length === 11) return '55' + digits

  // Qualquer outra coisa (ex.: timestamps/IDs) NÃO é telefone BR
  return ''
}

/**
 * Retorna variações prováveis do mesmo número BR para BUSCA/DEDUP:
 * - 55DD9XXXXXXXX (13) ↔ 55DDXXXXXXXX (12)
 * Útil quando a base tem registros com/sem o dígito 9 após o DDD.
 *
 * ATENÇÃO: isto é para "match" e deduplicação heurística, não para envio.
 *
 * @param {string} phone
 * @returns {string[]} lista única (somente dígitos ou JID de grupo)
 */
function possiblePhonesBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return []
  if (s.endsWith('@g.us')) return [s]

  // Chave sintética LID (espelhamento sem número real): NÃO gerar variantes de telefone.
  // Retorna array vazio para não criar buscas/inserts com chave inválida na tabela clientes.
  if (s.startsWith('lid:')) return []

  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '')
  if (!digits) return []

  const list = [digits]
  if (digits.startsWith('55')) {
    // 55 + DDD(2) + 9 + 8 = 13  → versão sem o 9 vira 12
    if (digits.length === 13 && digits.slice(4, 5) === '9') {
      list.push(digits.slice(0, 4) + digits.slice(5))
    }
    // 55 + DDD(2) + 8 = 12 → versão com 9 vira 13
    if (digits.length === 12) {
      list.push(digits.slice(0, 4) + '9' + digits.slice(4))
    }
  }
  return Array.from(new Set(list.filter(Boolean)))
}

/**
 * Chave de deduplicação BR:
 * - Se vier 13 dígitos no padrão 55DD9XXXXXXXX, remove o "9" após o DDD.
 * - Caso contrário, retorna os dígitos como estão.
 *
 * @param {string} phone
 * @returns {string}
 */
function phoneKeyBR(phone) {
  const s = String(phone || '').trim()
  if (!s) return ''
  if (s.endsWith('@g.us')) return s
  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '')
  // Fallback internacional: quando não normaliza em BR, usa os dígitos puros.
  // Assim evitamos chave vazia (que colapsa múltiplos contatos em um só).
  if (!digits) {
    const anyDigits = s.replace(/\D/g, '')
    if (anyDigits.length >= 10 && anyDigits.length <= 15) return anyDigits
    return ''
  }
  if (digits.startsWith('55') && digits.length === 13 && digits.slice(4, 5) === '9') {
    return digits.slice(0, 4) + digits.slice(5)
  }
  return digits
}

/**
 * Normaliza identificador de GRUPO vindo do WhatsApp/Z-API para armazenamento.
 * Alguns providers usam:
 * - "120363...@g.us"
 * - "120363...-group"
 *
 * Em bancos antigos, `conversas.telefone` pode ser varchar(20). Para não quebrar,
 * retornamos apenas dígitos (geralmente 18–19), suficiente para chave estável do grupo.
 *
 * @param {string} groupId
 * @returns {string}
 */
function normalizeGroupIdForStorage(groupId) {
  const s = String(groupId || '').trim()
  if (!s) return ''
  const digits = s.replace(/\D/g, '')
  return digits || s
}

/**
 * Formato para ENVIO via Z-API: WhatsApp Brasil exige 13 dígitos para celular (55 + DDD + 9 + 8 dígitos).
 * Se o número tiver 12 dígitos (55 + DDD + 8), insere o "9" após o DDD para tentar envio ao celular.
 * Evita erro 400 da Z-API por número em formato antigo.
 *
 * @param {string} phone - Número já normalizado (ex: 553484079198)
 * @returns {string}
 */
function toZapiSendFormat(phone) {
  const s = String(phone || '').trim()
  if (s.endsWith('@g.us')) return s

  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  // grupo numérico (120...): enviar como está
  if (digits.startsWith('120') && digits.length >= 15 && digits.length <= 22) return digits
  if (digits.length === 10 || digits.length === 11) return '55' + digits
  if (!digits.startsWith('55') || digits.length < 12) return ''

  if (digits.length === 13) return digits
  if (digits.length === 12) {
    const ddd = digits.slice(2, 4)
    const rest = digits.slice(4)
    return '55' + ddd + '9' + rest
  }
  return ''
}

/**
 * Escolhe o MELHOR número BR para ENVIO, ciente de celular vs fixo.
 *
 * Motivação: `toZapiSendFormat` insere o nono dígito em QUALQUER número de 12
 * dígitos, o que está certo para celular mas erra o fixo (fixo não tem nono
 * dígito). Já mandar o celular guardado sem o 9 (55+DDD+8) cai em "número não
 * existe" no WhatsApp. Aqui decidimos pelo 1º dígito do número local (8 díg):
 *   - 6,7,8,9 → celular → insere o 9 → 13 dígitos
 *   - 2,3,4,5 → fixo    → mantém 12 dígitos (sem 9)
 * Números já com 13 dígitos ou não-BR passam sem alteração.
 *
 * Retorna somente dígitos (sem "+"), ou '' quando não se aplica (grupo/LID/inválido),
 * deixando o chamador cair no fluxo padrão.
 *
 * @param {string} phone
 * @returns {string}
 */
function preferredBrSendDigits(phone) {
  const s = String(phone || '').trim()
  if (!s || s.endsWith('@g.us') || s.includes('-group') || isLidPhoneKey(s)) return ''
  const rawDigits = s.replace(/\D/g, '')
  if (!rawDigits || rawDigits.startsWith('120')) return ''
  const norm = String(normalizePhoneBR(s) || '').replace(/\D/g, '')
  if (!norm.startsWith('55')) return ''
  if (norm.length === 13) return norm // já completo (55+DDD+9+8)
  if (norm.length === 12) {
    const localFirst = norm.charAt(4) // 1º dígito do número local de 8 dígitos
    if ('6789'.includes(localFirst)) return norm.slice(0, 4) + '9' + norm.slice(4) // celular
    return norm // fixo: mantém 12 dígitos
  }
  return ''
}

/**
 * Primeiro dígito do número local BR (após 55+DDD), para distinguir celular (6–9) de fixo (2–5).
 */
function brLocalFirstDigit(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d.startsWith('55')) return ''
  if (d.length === 13 && d.charAt(4) === '9') return d.charAt(5)
  if (d.length === 12) return d.charAt(4)
  return ''
}

function isLikelyBrMobileDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d.startsWith('55')) return false
  if (d.length === 13 && d.charAt(4) === '9') return '6789'.includes(d.charAt(5))
  if (d.length === 12) return '6789'.includes(d.charAt(4))
  return false
}

/**
 * Variantes do mesmo JID WhatsApp para foto/metadados.
 * Celular: 12↔13 (com/sem 9) quando o local começa com 6–9.
 * Fixo: NÃO inventa o 9 — 5534 3xxxxxxx e 5534 93xxxxxxx são pessoas diferentes
 * (possiblePhonesBR misturava os dois e gravava a foto no contato errado).
 */
function possiblePhonesForWhatsappIdentity(phone) {
  const s = String(phone || '').trim()
  if (!s) return []
  if (s.endsWith('@g.us')) return [s]
  if (s.startsWith('lid:')) return []

  const norm = normalizePhoneBR(s)
  const digits = String(norm || '').replace(/\D/g, '') || String(s).replace(/\D/g, '')
  if (!digits || digits.startsWith('120')) return digits && !digits.startsWith('120') ? [digits] : []

  const list = [digits]
  if (!digits.startsWith('55')) return Array.from(new Set(list.filter(Boolean)))

  if (digits.length === 13 && digits.charAt(4) === '9') {
    const without9 = digits.slice(0, 4) + digits.slice(5)
    if (isLikelyBrMobileDigits(without9) || isLikelyBrMobileDigits(digits)) {
      if ('6789'.includes(without9.charAt(4))) list.push(without9)
    }
  }
  if (digits.length === 12 && isLikelyBrMobileDigits(digits)) {
    list.push(digits.slice(0, 4) + '9' + digits.slice(4))
  }
  return Array.from(new Set(list.filter(Boolean)))
}

/**
 * Chave estável da identidade WhatsApp (foto/perfil).
 * Celular com/sem 9 casa; fixo NÃO casa com um celular que só difere pelo 9 após o DDD.
 */
function whatsappIdentityKey(phone) {
  const s = String(phone || '').trim()
  if (!s || s.startsWith('lid:')) return ''
  if (s.endsWith('@g.us')) return s
  const digits = String(normalizePhoneBR(s) || '').replace(/\D/g, '') || String(s).replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('55') && digits.length === 13 && digits.charAt(4) === '9') {
    const without9 = digits.slice(0, 4) + digits.slice(5)
    if ('6789'.includes(without9.charAt(4))) return without9
    return digits
  }
  return digits
}

function isSameWhatsappIdentity(a, b) {
  const ka = whatsappIdentityKey(a)
  const kb = whatsappIdentityKey(b)
  if (ka && kb && ka === kb) return true
  const da = String(a || '').replace(/\D/g, '')
  const db = String(b || '').replace(/\D/g, '')
  return Boolean(da && db && da === db)
}

/**
 * Verifica se o chatId é de um grupo WhatsApp (@g.us ou ID 120...).
 *
 * @param {string} chatId - JID ou identificador (ex: 5511999999999@c.us, 120363...@g.us)
 * @returns {boolean}
 */
function isGroupChat(chatId) {
  const s = String(chatId || '').trim()
  if (!s) return false
  if (s.endsWith('@g.us')) return true
  const digits = s.replace(/\D/g, '')
  return digits.startsWith('120') && digits.length >= 15
}

/**
 * Verifica se o chatId é de contato individual (não grupo).
 *
 * @param {string} chatId
 * @returns {boolean}
 */
function isIndividualChat(chatId) {
  if (!chatId) return false
  return !isGroupChat(chatId) && (String(chatId).includes('@') || String(chatId).replace(/\D/g, '').length >= 10)
}

/**
 * Extrai o telefone (apenas dígitos) do chatId.
 * Ex: "5511999999999@c.us" → "5511999999999"
 *
 * @param {string} chatId
 * @returns {string}
 */
function extractPhoneFromChatId(chatId) {
  const s = String(chatId || '').trim()
  if (!s || s.endsWith('@g.us')) return ''
  const match = s.match(/^(\d+)@c\.us$/i)
  if (match) return match[1]
  const phone = s.replace(/@[^@]+$/, '').replace(/\D/g, '').trim()
  return phone || ''
}

/**
 * Chave sintética LID (espelhamento WhatsApp sem número real).
 * Nunca deve ser exibida como telefone nem enviada ao UltraMSG como chatId.
 */
function isLidPhoneKey(phone) {
  const s = String(phone || '').trim().toLowerCase()
  if (!s) return false
  return s.startsWith('lid:') || s.endsWith('@lid')
}

/**
 * Primeiro telefone real entre candidatos (ignora vazio, LID, broadcast).
 * Usado em UI (telefone_exibivel) e sync-old.
 * Só aceita números que passam em normalizePhoneBR (evita IDs LID numéricos longos).
 *
 * @param {...unknown} values
 * @returns {string|null}
 */
function pickRealPhoneCandidate(...values) {
  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw || isLidPhoneKey(raw)) continue
    const lower = raw.toLowerCase()
    if (lower.includes('@broadcast') || lower.includes('@newsletter')) continue
    if (lower.endsWith('@g.us')) continue
    if (lower.endsWith('@c.us')) {
      const fromChat = extractPhoneFromChatId(raw)
      if (normalizePhoneBR(fromChat)) return raw
      continue
    }
    if (normalizePhoneBR(raw)) return raw
  }
  return null
}

module.exports = {
  normalizePhoneBR,
  toZapiSendFormat,
  preferredBrSendDigits,
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  whatsappIdentityKey,
  isSameWhatsappIdentity,
  isLikelyBrMobileDigits,
  brLocalFirstDigit,
  phoneKeyBR,
  normalizeGroupIdForStorage,
  isGroupChat,
  isIndividualChat,
  extractPhoneFromChatId,
  isLidPhoneKey,
  pickRealPhoneCandidate,
}
