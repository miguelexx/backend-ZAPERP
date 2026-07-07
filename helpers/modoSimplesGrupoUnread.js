const supabase = require('../config/supabase')
const { isGroupConversation } = require('./conversaHelper')

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

/**
 * IDs de grupos com mensagens não lidas para o usuário (modo simples — aba Aguardando atendente).
 */
async function resolveGrupoIdsComUnreadParaUsuario({ company_id, unreadMap }) {
  if (!unreadMap || typeof unreadMap !== 'object') return []
  const ids = Object.entries(unreadMap)
    .filter(([, count]) => Number(count) > 0)
    .map(([id]) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (!ids.length) return []

  const { data, error } = await supabase
    .from('conversas')
    .select('id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .in('id', ids)

  if (error) {
    console.warn('[modoSimplesGrupo] resolveGrupoIds:', error.message || error)
    return []
  }

  return (data || [])
    .filter((row) => isGroupConversation(row))
    .map((row) => Number(row.id))
    .filter((n) => Number.isFinite(n) && n > 0)
}

/** Filtro SQL: individuais (modo_simples_aguardando) + grupos não lidos. */
function applyAguardandoAtendenteModoSimplesQuery(query, grupoUnreadIds = []) {
  const ids = (Array.isArray(grupoUnreadIds) ? grupoUnreadIds : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)

  if (ids.length > 0) {
    return query.or(
      `and(or(tipo.is.null,tipo.neq.grupo),modo_simples_aguardando.eq.atendente),id.in.(${ids.join(',')})`
    )
  }
  return query.or('tipo.is.null,tipo.neq.grupo').eq('modo_simples_aguardando', 'atendente')
}

function rowAguardandoAtendenteModoSimples(row, unreadCount = 0) {
  if (isGroupConversation(row)) return Number(unreadCount) > 0
  return String(row?.modo_simples_aguardando || '').toLowerCase() === 'atendente'
}

module.exports = {
  obterUnreadMap,
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
}
