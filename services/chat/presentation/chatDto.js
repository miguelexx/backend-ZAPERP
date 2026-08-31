/**
 * Formatação/DTO puros da lista de conversas.
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 */

/**
 * Junta as etiquetas da conversa com as do cliente removendo duplicadas. A mesma etiqueta pode
 * vir pelas duas fontes (ou como linhas repetidas na join), às vezes com id diferente mas o mesmo
 * nome — visualmente é a mesma e a escola reclamava de aparecer duas. Deduplica pelo nome
 * normalizado (etiqueta igual = duplicada mesmo com id diferente), caindo para o id quando não
 * houver nome, e também dedup dentro de cada fonte. Preserva a ordem (conversa antes do cliente).
 */
function mergeConversaClienteTags(c) {
  const conversaTags = (c.conversa_tags || []).map((ct) => ct?.tags).filter(Boolean)
  const clienteTags = (c.clientes?.cliente_tags || []).map((ct) => ct?.tags).filter(Boolean)
  const seen = new Set()
  const merged = []
  const tagKey = (t) => {
    const nome = String(t?.nome ?? '').trim().toLowerCase()
    return nome ? `n:${nome}` : t?.id != null ? `i:${String(t.id)}` : ''
  }
  for (const t of [...conversaTags, ...clienteTags]) {
    const key = tagKey(t)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    merged.push(t)
  }
  return merged
}

/**
 * Na listagem, conversas com status "aberta" no BD mas sem mensagem e sem atendente não são tratadas
 * como abertas nas abas (contagem / filtro). Expõe `ociosa` no JSON; o BD permanece `aberta` para constraints e fluxos internos.
 */
function statusAtendimentoParaLista(isGroup, dbStatus, exibirBadgeAberta) {
  if (isGroup) return null
  const s = dbStatus != null ? String(dbStatus) : null
  if (s === 'aberta' && !exibirBadgeAberta) return 'ociosa'
  return s
}

function safeWhatsappInstanceMeta(instance) {
  if (!instance) return {}
  return {
    whatsapp_instance_id: instance.id ?? null,
    whatsapp_instance_nome: instance.nome ?? null,
    whatsapp_instance_provider: instance.provider ?? null,
    whatsapp_instance_display_phone: instance.display_phone ?? null,
  }
}

module.exports = {
  mergeConversaClienteTags,
  statusAtendimentoParaLista,
  safeWhatsappInstanceMeta,
}
