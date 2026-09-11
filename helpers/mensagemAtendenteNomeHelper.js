/**
 * Nome do atendente em mensagens outbound (WhatsApp + reconciliação webhook fromMe).
 * Formato no aparelho do cliente (estilo WhatsApp):
 *
 *   *Nome:*
 *
 *   mensagem
 */

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove *negrito* WhatsApp e ":" final do rótulo do atendente. */
function normalizarRotuloNome(linha) {
  return String(linha || '')
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .trim()
    .replace(/:$/, '')
    .trim()
}

/**
 * Remove primeira linha quando for só o nome do atendente (com ou sem *negrito* / ":").
 * Aceita linha em branco entre o nome e o corpo.
 * @param {string} texto
 * @param {string} [nomeEsperado]
 */
function stripPrefixoAtendenteNoTexto(texto, nomeEsperado) {
  const raw = String(texto || '').trim()
  if (!raw) return raw
  const lines = raw.split('\n')
  if (lines.length < 2) return raw
  const first = String(lines[0] || '').trim()
  const plainFirst = normalizarRotuloNome(first)
  const nome = nomeEsperado ? String(nomeEsperado).trim() : ''
  if (nome && plainFirst.toLowerCase() !== nome.toLowerCase()) return raw
  if (!nome && !plainFirst) return raw
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
    const variants = [
      `*${nome}:*\n\n${c}`,
      `*${nome}:*\n${c}`,
      `*${nome}*\n\n${c}`,
      `*${nome}*\n${c}`,
    ]
    const wLow = w.toLowerCase()
    if (variants.some((p) => w === p || wLow === p.toLowerCase())) return true
  }
  return false
}

/**
 * Texto enviado ao WhatsApp (UltraMsg). CRM grava sem prefixo; o cliente vê:
 *   *Nome:*
 *
 *   mensagem
 * @param {string} texto
 * @param {string|null|undefined} usuarioNome
 */
function formatTextoWhatsappComNomeAtendente(texto, usuarioNome) {
  const t = String(texto || '').trim()
  const nome = usuarioNome ? String(usuarioNome).trim() : ''
  if (!nome) return t
  if (!t) return `*${nome}:*`
  const firstLine = String(t.split('\n')[0] || '').trim()
  const plainFirst = normalizarRotuloNome(firstLine)
  if (plainFirst.toLowerCase() === nome.toLowerCase()) return t
  return `*${nome}:*\n\n${t}`
}

/** Extrai nome da primeira linha quando vier como *Nome:*, *Nome* ou Nome (webhook fromMe). */
function extrairNomePrefixoTexto(texto) {
  const raw = String(texto || '').trim()
  const first = raw.split('\n')[0]?.trim() || ''
  if (!first || !raw.includes('\n')) return null
  const m = first.match(/^\*(.+)\*$/)
  if (m) return normalizarRotuloNome(m[1])
  if (first.length <= 80) return normalizarRotuloNome(first)
  return null
}

module.exports = {
  stripPrefixoAtendenteNoTexto,
  textosOutboundFromMeEquivalentes,
  formatTextoWhatsappComNomeAtendente,
  extrairNomePrefixoTexto,
  escapeRegex,
  normalizarRotuloNome,
}
