const supabase = require('../config/supabase')

/**
 * Colaboradores para quem uma conversa pode ser encaminhada (`colaboradores_encaminhar` do
 * GET /chats), cacheados por `company_id` (doc 41 §7).
 *
 * Era uma closure dentro de `listarConversas` lendo `usuarios` ativos da empresa a cada página
 * da lista. A chave NÃO inclui `user_id`: a lista COMPLETA da empresa fica no cache e o
 * `neq('id', user_id)` original vira filtro em memória — assim N usuários da mesma empresa
 * partilham uma consulta. Ordem (por nome, do banco) e formato dos itens são os de antes.
 *
 * Invalidação: `invalidateColaboradoresEncaminharCache(company_id)` em `userController`
 * (criar, atualizar, excluir/desativar). Outro caminho de escrita em `usuarios` que mude
 * nome/email/perfil/ativo deve chamá-la também.
 */
const _cache = require('./shortTtlCache').create({
  name: 'colaboradoresEncaminhar',
  ttlMs: Number(process.env.COLABORADORES_ENCAMINHAR_CACHE_TTL_MS || 60_000),
  max: 500,
})

async function lerColaboradoresDoBanco(cid) {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, email, perfil')
    .eq('company_id', cid)
    .eq('ativo', true)
    .order('nome', { ascending: true })
  // Lança para a falha NÃO ficar cacheada; o chamador devolve [] como a closure devolvia.
  if (error) throw error
  return (data || []).map((u) => ({
    usuario_id: Number(u.id),
    nome: u.nome ?? null,
    email: u.email ?? null,
    perfil: u.perfil ?? null,
  }))
}

/**
 * @param {number} company_id
 * @param {number} user_id  usuário chamador — excluído da lista (equivalente ao `neq` original)
 * @returns {Promise<Array<{usuario_id:number,nome:string|null,email:string|null,perfil:string|null}>>}
 */
async function listarColaboradoresEncaminhar(company_id, user_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return []
  let todos
  try {
    todos = await _cache.wrap(cid, '', () => lerColaboradoresDoBanco(cid))
  } catch (_) {
    return []
  }
  const uid = Number(user_id)
  // Cópias: nenhum chamador muta hoje; a cópia garante que o cache não seja alterado por fora.
  return todos.filter((u) => u.usuario_id !== uid).map((u) => ({ ...u }))
}

/** Invalida a lista cacheada da empresa (sem argumento: todas). */
function invalidateColaboradoresEncaminharCache(company_id) {
  if (company_id == null) { _cache.clear(); return }
  _cache.invalidate(company_id)
}

module.exports = {
  listarColaboradoresEncaminhar,
  invalidateColaboradoresEncaminharCache,
  _colaboradoresEncaminharCache: _cache,
}
