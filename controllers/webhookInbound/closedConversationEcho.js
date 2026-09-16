/**
 * Detecta eco da nossa própria outbound numa conversa já encerrada.
 * Usado antes de reabrir + disparar boas-vindas (bug: finalizar reabria o menu sozinho).
 */

const { shouldSkipReopenAsOwnOutboundEcho } = require('./reopenPolicy')
const { getRecentClosedConversation } = require('./recentClosedConversationGuard')

const RECENT_OUTBOUND_WINDOW_MS = 3 * 60 * 1000

async function loadRecentOutboundTexts(supabase, { company_id, conversa_id }) {
  if (!supabase || !company_id || !conversa_id) return []
  const fromIso = new Date(Date.now() - RECENT_OUTBOUND_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('mensagens')
    .select('texto')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('direcao', 'out')
    .gte('criado_em', fromIso)
    .order('criado_em', { ascending: false })
    .limit(12)
  if (error) return []
  return (data || []).map((r) => r.texto).filter(Boolean)
}

async function detectOwnOutboundEcho({ supabase, company_id, conversa_id, texto, messageId } = {}) {
  const inboundText = String(texto || '').trim()
  if (!inboundText) return { isEcho: false, reason: 'empty' }

  const mem = getRecentClosedConversation(company_id, conversa_id)
  const texts = [...(mem?.texts || [])]

  if (messageId && supabase && company_id) {
    try {
      const waId = String(messageId).trim()
      if (waId) {
        const { data: existing } = await supabase
          .from('mensagens')
          .select('id, direcao')
          .eq('company_id', company_id)
          .eq('whatsapp_id', waId)
          .eq('direcao', 'out')
          .maybeSingle()
        if (existing?.id) {
          return { isEcho: true, reason: 'whatsapp_id_outbound' }
        }
      }
    } catch (_) { /* lookup best-effort */ }
  }

  const fromDb = await loadRecentOutboundTexts(supabase, { company_id, conversa_id })
  texts.push(...fromDb)

  const decision = shouldSkipReopenAsOwnOutboundEcho({
    inboundText,
    recentOutboundTexts: texts,
  })
  return { isEcho: decision.skip, reason: decision.reason }
}

module.exports = {
  detectOwnOutboundEcho,
  loadRecentOutboundTexts,
}
