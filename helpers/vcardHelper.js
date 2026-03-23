/**
 * Parseia vCard 3.0 para extrair nome, telefone e descrição de negócio (cartão de contato WhatsApp).
 * Usado ao receber mensagens de contato via webhook.
 *
 * @param {string} vcard - Texto vCard (BEGIN:VCARD...END:VCARD)
 * @returns {{ nome: string|null, telefone: string|null, descricao_negocio?: string|null }}
 */
function parseVcardForContact(vcard) {
  if (!vcard || typeof vcard !== 'string') return { nome: null, telefone: null }
  const s = String(vcard).trim()
  if (!s) return { nome: null, telefone: null }

  let nome = null
  let telefone = null
  let descricaoNegocio = null

  // X-WA-BIZ-NAME: nome do negócio (WhatsApp Business)
  const bizNameMatch = s.match(/X-WA-BIZ-NAME:([^\r\n]+)/i)
  if (bizNameMatch && bizNameMatch[1]) {
    nome = String(bizNameMatch[1]).trim()
  }
  // FN:Display Name (formatted name - mais comum para exibição)
  if (!nome) {
    const fnMatch = s.match(/FN:([^\r\n]+)/i)
    if (fnMatch && fnMatch[1]) {
      nome = String(fnMatch[1]).trim()
    }
  }
  // N:last;first;middle;prefix;suffix
  if (!nome) {
    const nMatch = s.match(/N:([^\r\n]+)/i)
    if (nMatch && nMatch[1]) {
      const parts = String(nMatch[1]).split(';').filter(Boolean).map(p => p.trim())
      nome = parts.slice(0, 2).reverse().join(' ').trim() || parts[0] || null
    }
  }

  // TEL;TYPE=CELL;waid=5511999999999:+5511999999999 ou TEL:+5511999999999
  const telMatch = s.match(/TEL[^:]*:([^\r\n;]+)/i)
  if (telMatch && telMatch[1]) {
    const raw = String(telMatch[1]).replace(/\D/g, '')
    if (raw.length >= 10) {
      // Normalizar para padrão BR quando aplicável
      telefone = raw.startsWith('55') && (raw.length === 12 || raw.length === 13)
        ? raw
        : raw.length === 10 || raw.length === 11
          ? '55' + raw
          : raw
    }
  }

  // X-WA-BIZ-DESCRIPTION: descrição do negócio (WhatsApp Business)
  const bizDescMatch = s.match(/X-WA-BIZ-DESCRIPTION:([^\r\n]+)/i)
  if (bizDescMatch && bizDescMatch[1]) {
    descricaoNegocio = String(bizDescMatch[1]).trim()
  }

  const result = { nome: nome || null, telefone: telefone || null }
  if (descricaoNegocio) result.descricao_negocio = descricaoNegocio
  return result
}

module.exports = { parseVcardForContact }
