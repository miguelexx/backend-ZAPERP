/**
 * Nome do atendente em mensagens outbound (WhatsApp + reconciliação webhook fromMe).
 */

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove primeira linha quando for só o nome do atendente (com ou sem *negrito* WhatsApp).
 * @param {string} texto
 * @param {string} [nomeEsperado]
 */
function stripPrefixoAtendenteNoTexto(texto, nomeEsperado) {
  const raw = String(texto || '').trim()
  if (!raw) return raw
  const lines = raw.split('\n')
  if (lines.length < 2) return raw
  const first = String(lines[0] || '').trim()
  const plainFirst = first.replace(/^\*+|\*+$/g, '').trim()
  const nome = nomeEsperado ? String(nomeEsperado).trim() : ''
  if (nome && plainFirst.toLowerCase() !== nome.toLowerCase()) return raw
  if (!nome && !/^\*?.+\*?$/.test(first)) return raw
  const rest = lines.slice(1).join('\n').trim()
  return rest || raw
}

/**
 * Compara texto do webhook (pode vir prefixado) com texto salvo no CRM (sem prefixo).
 */
function textosOutboundFromMeEquivalentes(textoWebhook, textoCrm, nomeAtendente) {
  const w = String(textoWebhook || '').trim()
  const c = String(textoCrm || '').trim()
  if (!w || !c) return false
  if (w === c || w.toLowerCase() === c.toLowerCase()) return true
  const wStripped = stripPrefixoAtendenteNoTexto(w, nomeAtendente)
  if (wStripped === c || wStripped.toLowerCase() === c.toLowerCase()) return true
  const nome = nomeAtendente ? String(nomeAtendente).trim() : ''
  if (nome) {
    const prefixed = `*${nome}*\n${c}`
    if (w === prefixed || w.toLowerCase() === prefixed.toLowerCase()) return true
  }
  return false
}

/**
 * Texto enviado ao WhatsApp (UltraMsg). CRM grava sem prefixo; o cliente vê *Nome* na primeira linha.
 * @param {string} texto
 * @param {string|null|undefined} usuarioNome
 */
function formatTextoWhatsappComNomeAtendente(texto, usuarioNome) {
  const t = String(texto || '').trim()
  const nome = usuarioNome ? String(usuarioNome).trim() : ''
  if (!nome) return t
  if (!t) return `*${nome}*`
  const firstLine = String(t.split('\n')[0] || '').trim()
  const plainFirst = firstLine.replace(/^\*+|\*+$/g, '').trim()
  if (plainFirst.toLowerCase() === nome.toLowerCase()) return t
  return `*${nome}*\n${t}`
}

/** Extrai nome da primeira linha quando vier como *Nome* ou Nome (webhook fromMe). */
function extrairNomePrefixoTexto(texto) {
  const raw = String(texto || '').trim()
  const first = raw.split('\n')[0]?.trim() || ''
  if (!first || !raw.includes('\n')) return null
  const m = first.match(/^\*(.+)\*$/)
  if (m) return m[1].trim()
  if (first.length <= 80) return first.replace(/^\*+|\*+$/g, '').trim()
  return null
}

module.exports = {
  stripPrefixoAtendenteNoTexto,
  textosOutboundFromMeEquivalentes,
  formatTextoWhatsappComNomeAtendente,
  extrairNomePrefixoTexto,
  escapeRegex,
}
