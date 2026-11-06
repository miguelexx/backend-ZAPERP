/**
 * Reply/citação do webhook inbound: resolve o `reply_meta` (a "resposta a X" que o front mostra acima
 * da mensagem) a partir do payload UltraMSG/Z-API. Extraído verbatim de receberZapi (Fase 5 — doc 24).
 *
 * Tenta muitos formatos de id da mensagem citada (referenceMessageId, referencedMessage.*, quoted*,
 * context*, contextInfo.*), busca a mensagem citada na conversa para nome/trecho e, no erro, cai num
 * fallback pelo corpo do próprio payload. Devolve `{ name, snippet, ts, replyToId }` ou `null`.
 */

const supabaseDefault = require('../../config/supabase')
const { applyWhatsappInstanceFilterOrLegacy } = require('./whatsappIdLookup')

/** Preço formatado em pt-BR (igual ao formatWhapiMoney do provider, sem acoplar o módulo). */
function formatReplyMoney(value, currency) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || 'BRL' }).format(num)
  } catch {
    return `R$ ${num.toFixed(2).replace('.', ',')}`
  }
}

async function buildWebhookReplyMeta(supabaseClient, { payload, company_id, conversa_id, whatsapp_instance_id }) {
  const supabase = supabaseClient || supabaseDefault
  let webhookReplyMeta = null

  // Pergunta do cliente SOBRE um produto do catálogo (Whapi product_inquiry): a "mensagem citada" é o
  // próprio produto (resolvido em enrichQuotedProduct → payload.quotedProduct). A citação mostra o
  // cartão (foto + nome + preço) em vez do rótulo solto "Mensagem". O produto não é uma mensagem na
  // thread, então sem replyToId (evita o toque "Mensagem não encontrada").
  const qp = payload?.quotedProduct
  if (qp && typeof qp === 'object' && (qp.name || qp.image || qp.id)) {
    const nome = String(qp.name || '').trim() || 'Produto'
    const preco = qp.price != null ? formatReplyMoney(qp.price, qp.currency) : ''
    return {
      name: '🛍️ ' + nome,
      snippet: preco || 'Produto do catálogo',
      ts: Date.now(),
      reply_kind: 'product',
      ...(qp.image ? { thumb: String(qp.image) } : {}),
    }
  }
  const refMsg = payload?.referencedMessage ?? payload?.quotedMsg ?? payload?.quoted ?? null
  const quotedIdRaw =
    payload?.referenceMessageId ??          // campo oficial Z-API ReceivedCallback
    payload?.referencedMessage?.messageId ??
    payload?.referencedMessage?.id ??
    payload?.quotedMsgId ??
    payload?.quotedMessageId ??
    payload?.quotedStanzaId ??
    payload?.context?.messageId ??          // Z-API context (algumas versões)
    payload?.context?.id ??
    payload?.contextInfo?.stanzaId ??
    payload?.contextInfo?.quotedStanzaId ??
    payload?.contextInfo?.quotedMessageId ??
    refMsg?.id ??
    refMsg?.messageId ??
    payload?.message?.contextInfo?.stanzaId ??
    payload?.message?.contextInfo?.quotedStanzaId ??
    payload?.message?.context?.messageId ??
    payload?.message?.context?.id ??
    null
  const quotedId = quotedIdRaw ? String(quotedIdRaw).trim() : null

  const refBodyFallback =
    String(
      payload?.referencedMessage?.body ??
      payload?.referencedMessage?.text?.message ??
      payload?.referencedMessage?.text?.body ??       // Whapi: text.body
      payload?.referencedMessage?.caption ??
      refMsg?.message ??
      refMsg?.body ??                                  // Whapi: context.quoted_content.body
      refMsg?.text?.message ??
      refMsg?.text?.body ??                            // Whapi: quoted_content.text.body
      refMsg?.caption ??
      ''
    ).trim().slice(0, 180) || null

  const refFromMe = payload?.referencedMessage?.fromMe ?? refMsg?.fromMe ?? null

  if (quotedId) {
    const replyTs = Date.now()
    try {
      let quotedQuery = supabase
        .from('mensagens')
        .select('texto, direcao, remetente_nome')
        .eq('company_id', company_id)
        .eq('conversa_id', conversa_id)
        .eq('whatsapp_id', quotedId)
      quotedQuery = applyWhatsappInstanceFilterOrLegacy(quotedQuery, whatsapp_instance_id)
      const { data: quoted } = await quotedQuery.maybeSingle()

      const snippet =
        String(quoted?.texto || '').trim().slice(0, 180) ||
        refBodyFallback ||
        'Mensagem'

      let name
      if (quoted) {
        name = quoted.direcao === 'out' ? 'Você' : (String(quoted.remetente_nome || '').trim() || 'Contato')
      } else {
        name = (refFromMe === true) ? 'Você' : 'Contato'
      }
      webhookReplyMeta = { name, snippet, ts: replyTs, replyToId: quotedId }
    } catch (_) {
      webhookReplyMeta = { name: (refFromMe === true ? 'Você' : 'Mensagem'), snippet: refBodyFallback || 'Mensagem', ts: replyTs, replyToId: quotedId }
    }
  }
  return webhookReplyMeta
}

module.exports = { buildWebhookReplyMeta }
