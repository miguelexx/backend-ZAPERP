/**
 * Sincronização de conversa/cliente por telefone canônico.
 * Garante um único contato e uma única conversa aberta por número (evita duplicata 55... vs 11...).
 */

const supabase = require('../config/supabase')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('./phoneHelper')

/**
 * Retorna telefone canônico para armazenamento (sempre o mesmo formato por número).
 * @param {string} phone
 * @returns {string}
 */
function getCanonicalPhone(phone) {
  if (!phone) return ''
  const s = String(phone).trim()
  if (s.endsWith('@g.us')) return s
  return normalizePhoneBR(s) || s.replace(/\D/g, '')
}

/**
 * Deduplica lista de conversas: uma por contato (por phoneKeyBR).
 * Mantém a conversa com atividade mais recente.
 * @param {Array} conversas - Lista de conversas formatadas (com telefone, ultima_atividade, criado_em, is_group)
 * @returns {Array}
 */
function deduplicateConversationsByContact(conversas) {
  if (!Array.isArray(conversas) || conversas.length === 0) return conversas
  const byKey = new Map()
  for (const c of conversas) {
    if (c.is_group) {
      byKey.set(`grupo:${c.id}`, c)
      continue
    }
    const key = (c.telefone && (phoneKeyBR(c.telefone) || String(c.telefone).replace(/\D/g, ''))) || `id:${c.id}`
    if (!key) {
      byKey.set(`id:${c.id}`, c)
      continue
    }
    const existing = byKey.get(key)
    const cTime = new Date(c.ultima_atividade || c.criado_em || 0).getTime()
    const exTime = existing ? new Date(existing.ultima_atividade || existing.criado_em || 0).getTime() : 0
    if (!existing || cTime >= exTime) byKey.set(key, c)
  }
  return Array.from(byKey.values())
}

/**
 * Ordena conversas: mais recentes no topo (como WhatsApp).
 * @param {Array} conversas
 * @returns {Array}
 */
function sortConversationsByRecent(conversas) {
  if (!Array.isArray(conversas)) return conversas
  return [...conversas].sort((a, b) => {
    const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
    const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
    if (tb !== ta) return tb - ta
    return (Number(b.id) || 0) - (Number(a.id) || 0)
  })
}

module.exports = { getCanonicalPhone, deduplicateConversationsByContact, sortConversationsByRecent }
