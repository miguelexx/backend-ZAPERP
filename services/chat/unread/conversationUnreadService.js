/**
 * Leitura/limpeza de não-lidas por usuário (conversa_unreads).
 * Extraído de controllers/chatController.js (Fase 4 da modularização) sem alteração de comportamento.
 */

const supabase = require('../../../config/supabase')

async function marcarComoLidaPorUsuario({ company_id, conversa_id, usuario_id }) {
  // Filtros .gt/.eq: mesmo estado final, mas evita UPDATE morto (nova versão de tupla +
  // reindexação) em toda abertura/paginação de conversa já lida.
  const results = await Promise.all([
    supabase
      .from('conversa_unreads')
      .update({
        unread_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('company_id', Number(company_id))
      .eq('conversa_id', Number(conversa_id))
      .eq('usuario_id', Number(usuario_id))
      .gt('unread_count', 0),
    supabase
      .from('conversas')
      .update({ lida: true })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))
      .eq('lida', false)
  ])
  const failed = results.find((result) => result?.error)
  if (failed) throw failed.error
}

async function obterUnreadMap({ company_id, usuario_id }) {
  // .gt(0): linhas zeradas nunca são apagadas (marcarComoLida só zera o contador), então sem
  // o filtro um admin acumula uma linha por conversa da empresa e o PostgREST corta em 1000
  // linhas SEM ordem definida — badges de não lida sumiam aleatoriamente. Consumidores tratam
  // chave ausente como 0.
  const { data, error } = await supabase
    .from('conversa_unreads')
    .select('conversa_id, unread_count')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))
    .gt('unread_count', 0)

  if (error) return {}

  const map = {}
  for (const row of data || []) {
    map[Number(row.conversa_id)] = Number(row.unread_count || 0)
  }
  return map
}

module.exports = { marcarComoLidaPorUsuario, obterUnreadMap }
