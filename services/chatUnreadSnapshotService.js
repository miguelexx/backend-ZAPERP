const supabase = require('../config/supabase')
const { applyChatListSqlFilters } = require('./chatListCountsService')

const PAGE_SIZE = 200

// Sem teto de IDs: permissões antigas e grupos também participam do snapshot.
async function readAll(buildQuery) {
  const result = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Resposta inválida ao consultar não lidas')
    result.push(...data)
    if (data.length < PAGE_SIZE) return result
  }
}

async function getAuthorizedIds(user, ids) {
  const company_id = Number(user.company_id)
  const user_id = Number(user.id)
  const isAdmin = String(user.perfil || '').toLowerCase() === 'admin'
  const ctx = {
    company_id, user_id, isAdmin,
    departamento_ids: user.departamento_ids || [],
    conversaIdsTransferidas: [], conversaIdsParticipanteAtivo: [],
    grupoIdsPermitidosPorDepartamento: [], grupoIdsSemDepartamento: [],
  }
  if (!isAdmin) {
    const [transfers, participants, groupDepartments, groups] = await Promise.all([
      readAll(() => supabase.from('atendimentos').select('id,conversa_id').eq('company_id', company_id)
        .eq('de_usuario_id', user_id).eq('acao', 'transferiu').in('conversa_id', ids)),
      readAll(() => supabase.from('conversa_atendentes').select('id,conversa_id').eq('company_id', company_id)
        .eq('usuario_id', user_id).eq('ativo', true).in('conversa_id', ids)),
      readAll(() => supabase.from('departamento_grupos').select('id,conversa_id,departamento_id')
        .eq('company_id', company_id).in('conversa_id', ids)),
      readAll(() => supabase.from('conversas').select('id').eq('company_id', company_id).eq('tipo', 'grupo').in('id', ids)),
    ])
    const departments = new Set(ctx.departamento_ids.map(Number))
    const linkedGroups = new Set(groupDepartments.map((row) => Number(row.conversa_id)))
    ctx.conversaIdsTransferidas = [...new Set(transfers.map((row) => Number(row.conversa_id)))]
    ctx.conversaIdsParticipanteAtivo = [...new Set(participants.map((row) => Number(row.conversa_id)))]
    ctx.grupoIdsPermitidosPorDepartamento = [...new Set(groupDepartments
      .filter((row) => departments.has(Number(row.departamento_id))).map((row) => Number(row.conversa_id)))]
    ctx.grupoIdsSemDepartamento = groups.filter((row) => !linkedGroups.has(Number(row.id))).map((row) => Number(row.id))
  }
  const { data, error } = await applyChatListSqlFilters(
    supabase.from('conversas').select('id').in('id', ids), ctx, { visibilityOnly: true }
  )
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Resposta inválida ao validar visibilidade')
  return new Set(data.map((row) => Number(row.id)))
}

/** Total por usuário/empresa, independente de aba, busca ou filtros da tela. */
async function getUnreadSnapshot(req) {
  const user = req.user || {}
  const companyId = Number(user.company_id)
  const userId = Number(user.id)
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Escopo de sessão inválido para não lidas')
  }
  const unread_by_id = {}
  let cursor = 0
  for (;;) {
    const { data, error } = await supabase.from('conversa_unreads').select('conversa_id,unread_count')
      .eq('company_id', companyId).eq('usuario_id', userId).gt('unread_count', 0)
      .gt('conversa_id', cursor).order('conversa_id', { ascending: true }).limit(PAGE_SIZE)
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Snapshot de não lidas incompleto')
    if (data.length === 0) break
    const ids = data.map((row) => Number(row.conversa_id))
    const allowed = await getAuthorizedIds(user, ids)
    for (const row of data) {
      if (allowed.has(Number(row.conversa_id))) unread_by_id[row.conversa_id] = Math.max(0, Number(row.unread_count) || 0)
    }
    const nextCursor = ids[ids.length - 1]
    if (!(nextCursor > cursor)) throw new Error('Paginação de não lidas sem progresso')
    cursor = nextCursor
    if (data.length < PAGE_SIZE) break
  }
  return {
    unread_by_id,
    unread_total: Object.values(unread_by_id).reduce((total, count) => total + count, 0),
    company_id: companyId, usuario_id: userId,
  }
}

module.exports = { getUnreadSnapshot }
