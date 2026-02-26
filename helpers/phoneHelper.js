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
  // Chave sintética LID (espelhamento): uma única variante
  if (s.startsWith('lid:') && s.length > 4) return [s]

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
  const digits = normalizePhoneBR(s).replace(/\D/g, '')
  if (!digits) return ''
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

module.exports = { normalizePhoneBR, toZapiSendFormat, possiblePhonesBR, phoneKeyBR, normalizeGroupIdForStorage }
