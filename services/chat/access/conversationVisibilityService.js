/**
 * Serviço de visibilidade de conversas: quem pode ver uma conversa (por perfil, setor, grupo,
 * responsável, participante e transferência), cache de visibilidade e incremento de unread.
 *
 * Extraído de controllers/chatController.js (Fase 2/3 da modularização) sem alteração de comportamento.
 * O cache (`conversaVisibilityCache`) é estado local ao processo, encapsulado neste módulo — a mesma
 * semântica não-distribuída do controller original.
 *
 * Regras: admin vê tudo; conversa assumida → sempre; setor → só usuários do setor; sem setor → todos.
 * EXCEÇÃO: usuários que transferiram a conversa veem independente do setor. Grupos seguem a política
 * de departamentos própria.
 */

const supabase = require('../../../config/supabase')
const { isGroupConversation } = require('../../../helpers/conversaHelper')
const { getGrupoDepartamentoIds } = require('../../../helpers/departamentoGruposHelper')
const { getChatFilterIdLimit } = require('../read/searchLimits')

const conversaVisibilityCache = new Map()
const CONVERSA_VISIBILITY_CACHE_TTL_MS = 15_000

function conversaVisibilityCacheKey(company_id, conversa_id) {
  return `${Number(company_id)}:${Number(conversa_id)}`
}

function invalidateConversaVisibilityCache(company_id, conversa_id) {
  if (company_id == null || conversa_id == null) return
  conversaVisibilityCache.delete(conversaVisibilityCacheKey(company_id, conversa_id))
}

function isConversaAtendentesMissingTable(error) {
  const msg = String(error?.message || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01' ||
    code === '42501' ||
    code === 'PGRST205' ||
    (msg.includes('conversa_atendentes') &&
      (msg.includes('does not exist') ||
        msg.includes('could not find') ||
        msg.includes('schema cache') ||
        msg.includes('permission denied'))) ||
    msg.includes('permission denied for table conversa_atendentes')
  )
}

async function getConversaParticipanteIdsAtivos(company_id, conversa_id) {
  if (company_id == null || conversa_id == null) return []
  const { data, error } = await supabase
    .from('conversa_atendentes')
    .select('usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('ativo', true)
  if (error) {
    if (isConversaAtendentesMissingTable(error)) return []
    throw error
  }
  return [...new Set((data || []).map((row) => Number(row.usuario_id)).filter((n) => Number.isFinite(n) && n > 0))]
}

async function getConversaIdsParticipanteAtivo(company_id, usuario_id) {
  if (company_id == null || usuario_id == null) return []
  const limit = getChatFilterIdLimit()
  const { data, error } = await supabase
    .from('conversa_atendentes')
    .select('conversa_id')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))
    .eq('ativo', true)
    .order('criado_em', { ascending: false })
    .limit(limit)
  if (error) {
    if (isConversaAtendentesMissingTable(error)) return []
    throw error
  }
  return [...new Set((data || []).map((row) => Number(row.conversa_id)).filter((n) => Number.isFinite(n) && n > 0))]
}

async function usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, usuario_id) {
  if (company_id == null || conversa_id == null || usuario_id == null) return false
  const { data, error } = await supabase
    .from('conversa_atendentes')
    .select('id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('usuario_id', Number(usuario_id))
    .eq('ativo', true)
    .limit(1)
    .maybeSingle()
  if (error) {
    if (isConversaAtendentesMissingTable(error)) return false
    throw error
  }
  return !!data
}

function payloadAlteraVisibilidadeConversa(payload) {
  if (!payload || typeof payload !== 'object') return false
  return (
    Object.prototype.hasOwnProperty.call(payload, 'departamento_id') ||
    Object.prototype.hasOwnProperty.call(payload, 'atendente_id') ||
    Object.prototype.hasOwnProperty.call(payload, 'tipo') ||
    Object.prototype.hasOwnProperty.call(payload, 'departamento_grupos')
  )
}

function deveIncluirGruposSemDepartamentoNoFiltroTodos({
  isAdmin,
  filter_dep_id,
  filtroAtendenteInformado,
  minhaFilaAtiva,
  aguardandoClienteAtivo,
  aguardandoAtendenteAtivo,
  pagamentoPendenteAtivo,
  emAtrasoAtivo,
  hojeAtivo,
  statusNorm,
}) {
  return (
    !isAdmin &&
    !filter_dep_id &&
    filtroAtendenteInformado == null &&
    !minhaFilaAtiva &&
    !aguardandoClienteAtivo &&
    !aguardandoAtendenteAtivo &&
    !pagamentoPendenteAtivo &&
    !emAtrasoAtivo &&
    !hojeAtivo &&
    !statusNorm
  )
}

async function carregarUsuarioIdsQuePodemVerConversaSemCache(company_id, conversa_id) {
  const { data: conv } = await supabase
    .from('conversas')
    .select('departamento_id, atendente_id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (!conv) return []

  const isGroup = isGroupConversation(conv)
  const convDep = conv.departamento_id ?? null
  const atendenteId = conv.atendente_id ? Number(conv.atendente_id) : null
  const grupoDepIds = isGroup ? await getGrupoDepartamentoIds(company_id, conversa_id) : []
  const grupoDepSet = new Set(grupoDepIds.map(Number))

  const { data: transferiuRows } = await supabase
    .from('atendimentos')
    .select('de_usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('acao', 'transferiu')
  const transferiuIds = new Set((transferiuRows || []).map((r) => Number(r.de_usuario_id)).filter(Boolean))
  const participanteIds = new Set(await getConversaParticipanteIdsAtivos(company_id, conversa_id))

  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, perfil, departamento_id')
    .eq('company_id', Number(company_id))
    .eq('ativo', true)
  if (!Array.isArray(usuarios) || usuarios.length === 0) return []

  let userDepMap = new Map()
  const { data: udRows } = await supabase
    .from('usuario_departamentos')
    .select('usuario_id, departamento_id')
    .eq('company_id', Number(company_id))
  if (Array.isArray(udRows)) {
    udRows.forEach((r) => {
      const uid = Number(r.usuario_id)
      if (!userDepMap.has(uid)) userDepMap.set(uid, [])
      userDepMap.get(uid).push(Number(r.departamento_id))
    })
  }

  const ids = []
  for (const u of usuarios) {
    const uid = Number(u.id)
    const isAdmin = String(u.perfil || '').toLowerCase() === 'admin'
    if (isAdmin) { ids.push(uid); continue }
    const userDepIds = userDepMap.get(uid) ?? (u.departamento_id != null ? [Number(u.departamento_id)] : [])
    if (isGroup) {
      if (grupoDepSet.size === 0 || userDepIds.some((d) => grupoDepSet.has(Number(d)))) ids.push(uid)
      continue
    }
    if (atendenteId && uid === atendenteId) { ids.push(uid); continue }
    if (participanteIds.has(uid)) { ids.push(uid); continue }
    if (transferiuIds.has(uid)) { ids.push(uid); continue }
    if (convDep == null) ids.push(uid)
    else if (userDepIds.some((d) => Number(d) === Number(convDep))) ids.push(uid)
  }
  return ids
}

async function obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id) {
  const key = conversaVisibilityCacheKey(company_id, conversa_id)
  const now = Date.now()
  const cached = conversaVisibilityCache.get(key)

  if (cached?.ids && cached.expiresAt > now) return [...cached.ids]
  if (cached?.promise) return [...(await cached.promise)]

  const promise = carregarUsuarioIdsQuePodemVerConversaSemCache(company_id, conversa_id)
  conversaVisibilityCache.set(key, {
    promise,
    expiresAt: now + CONVERSA_VISIBILITY_CACHE_TTL_MS,
  })

  try {
    const ids = await promise
    const safeIds = Array.isArray(ids) ? ids : []
    conversaVisibilityCache.set(key, {
      ids: safeIds,
      expiresAt: Date.now() + CONVERSA_VISIBILITY_CACHE_TTL_MS,
    })
    return [...safeIds]
  } catch (err) {
    conversaVisibilityCache.delete(key)
    throw err
  }
}

/**
 * Incrementa unread apenas para usuários que podem ver a conversa (por setor).
 * Quando o cliente escolhe um setor, só usuários daquele setor recebem notificação.
 *
 * Usa RPC `increment_conversa_unreads` para operação atômica com
 * INSERT ... ON CONFLICT DO UPDATE SET unread_count = unread_count + 1.
 *
 * A função RPC deve existir no banco (migration 20250225000000_production_hardening.sql).
 * Fallback para o método leitura-escrita se o RPC não existir ainda.
 */
async function incrementarUnreadParaConversa(company_id, conversa_id) {
  try {
    const usuarioIds = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
    if (usuarioIds.length === 0) return

    const cid = Number(company_id)
    const convId = Number(conversa_id)

    const { error: rpcErr } = await supabase.rpc('increment_conversa_unreads', {
      p_company_id: cid,
      p_conversa_id: convId,
      p_usuario_ids: usuarioIds,
    })

    if (!rpcErr) return

    const isNotFound = String(rpcErr.code || '').includes('PGRST202') ||
      String(rpcErr.message || '').includes('function') ||
      String(rpcErr.message || '').includes('not exist')

    if (!isNotFound) {
      console.warn('incrementarUnreadParaConversa rpc error:', rpcErr?.message || rpcErr)
    }

    const now = new Date().toISOString()
    const { data: existentes } = await supabase
      .from('conversa_unreads')
      .select('id, usuario_id, unread_count')
      .eq('company_id', cid)
      .eq('conversa_id', convId)
    const byUser = new Map((existentes || []).map((r) => [Number(r.usuario_id), r]))

    for (const uid of usuarioIds) {
      const row = byUser.get(uid)
      if (row) {
        await supabase
          .from('conversa_unreads')
          .update({ unread_count: Number(row.unread_count || 0) + 1, updated_at: now })
          .eq('id', row.id)
      } else {
        await supabase.from('conversa_unreads').insert({
          company_id: cid, conversa_id: convId, usuario_id: uid, unread_count: 1
        })
      }
    }
  } catch (e) {
    console.warn('incrementarUnreadParaConversa:', e?.message || e)
  }
}

module.exports = {
  invalidateConversaVisibilityCache,
  isConversaAtendentesMissingTable,
  getConversaParticipanteIdsAtivos,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  payloadAlteraVisibilidadeConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
  carregarUsuarioIdsQuePodemVerConversaSemCache,
  obterUsuarioIdsQuePodemVerConversa,
  incrementarUnreadParaConversa,
}
