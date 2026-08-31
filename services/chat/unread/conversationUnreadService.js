/**
 * Leitura/limpeza de não-lidas por usuário (conversa_unreads).
 * Extraído de controllers/chatController.js (Fase 4 da modularização) sem alteração de comportamento.
 */

const supabase = require('../../../config/supabase')

async function marcarComoLidaPorUsuario({ company_id, conversa_id, usuario_id }) {
  await Promise.all([
    supabase
      .from('conversa_unreads')
      .update({
        unread_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('company_id', Number(company_id))
      .eq('conversa_id', Number(conversa_id))
      .eq('usuario_id', Number(usuario_id)),
    supabase
      .from('conversas')
      .update({ lida: true })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))
  ])
}

async function obterUnreadMap({ company_id, usuario_id }) {
  const { data, error } = await supabase
    .from('conversa_unreads')
    .select('conversa_id, unread_count')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))

  if (error) return {}

  const map = {}
  for (const row of data || []) {
    map[Number(row.conversa_id)] = Number(row.unread_count || 0)
  }
  return map
}

module.exports = { marcarComoLidaPorUsuario, obterUnreadMap }
