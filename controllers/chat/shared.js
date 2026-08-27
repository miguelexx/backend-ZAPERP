'use strict'
/**
 * controllers/chat/shared.js
 *
 * Helpers de DADOS/LEITURA compartilhados entre o chatController (fachada + handlers de
 * escrita) e os módulos de leitura (chat/listController, chat/historyController).
 *
 * Responsabilidade: paginação/cursores da lista e do histórico, montagem de metadados de
 * instância WhatsApp, enriquecimento de mensagens (autor + "apagada para todos"),
 * permissão/participação em conversa, contadores de não lidas, limites de busca e
 * utilitários de filtro. NÃO contém emissão de socket nem regras de envio — estes
 * permanecem no chatController (serão modularizados em sessão posterior).
 *
 * Invariantes preservadas:
 * - Todo acesso a dados filtra company_id explicitamente (SERVICE_ROLE ignora RLS).
 * - Formato/campos de saída idênticos ao original (extraído sem alterar corpo).
 */

const supabase = require('../../config/supabase')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const { usuarioPodeVerGrupo } = require('../../helpers/departamentoGruposHelper')
const { escapeIlikePattern } = require('../../helpers/chatSearchHelper')

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

async function resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId) {
  if (!conversa?.chat_lid) return null
  let query = supabase
    .from('conversas')
    .select('telefone')
    .eq('company_id', company_id)
    .eq('chat_lid', conversa.chat_lid)
    .not('telefone', 'like', 'lid:%')
  if (whatsappInstanceId) {
    query = query.eq('whatsapp_instance_id', whatsappInstanceId)
  } else {
    query = query.is('whatsapp_instance_id', null)
  }
  const { data: outra } = await query.limit(1).maybeSingle()
  return outra?.telefone || null
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

async function loadWhatsappInstanceMetaMap(company_id, instanceIds) {
  const ids = [...new Set((instanceIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return new Map()
  try {
    const { data, error } = await supabase
      .from('whatsapp_instances')
      .select('id, company_id, nome, provider, display_phone')
      .eq('company_id', Number(company_id))
      .in('id', ids)
    if (error) {
      console.warn('[whatsapp_instances] metadados indisponiveis para conversas:', error.message || error)
      return new Map()
    }
    return new Map((data || []).map((row) => [Number(row.id), row]))
  } catch (err) {
    console.warn('[whatsapp_instances] falha ao enriquecer conversas:', err?.message || err)
    return new Map()
  }
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

/**
 * Paginação de mensagens em GET /chats/:id (detalharChat).
 * Com `cursor_id`: desempate quando várias mensagens compartilham o mesmo `criado_em` (ordem id DESC).
 * Sem `cursor_id`: compatível com clientes antigos — apenas `criado_em.lt`.
 */
function applyDetalharChatMensagensCursor(query, cursorEm, cursorIdRaw) {
  const em = cursorEm != null && String(cursorEm).trim() !== '' ? String(cursorEm).trim() : null
  if (!em) return query
  const idNum =
    cursorIdRaw !== undefined && cursorIdRaw !== null && String(cursorIdRaw).trim() !== ''
      ? Number(cursorIdRaw)
      : NaN
  if (Number.isFinite(idNum)) {
    const quoted = `"${em.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    return query.or(`criado_em.lt.${quoted},and(criado_em.eq.${quoted},id.lt.${idNum})`)
  }
  return query.lt('criado_em', em)
}

function parsePositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function parseBooleanQuery(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true'
}

/**
 * Flag de query string no formato ESTRITO das abas/chips da lista de conversas: só
 * 1 / '1' / true / 'true' (sem normalizar caixa). Mantém exatamente o contrato atual
 * de listarConversas — não substituir por parseBooleanQuery, que é mais permissivo.
 */
function isFlagAtivo(value) {
  return value === '1' || value === 'true' || value === 1 || value === true
}

/**
 * Detecta erro do PostgREST por coluna opcional ainda inexistente no banco (compat com
 * bancos desatualizados), nos selects de `mensagens` dos fluxos de LEITURA
 * (detalharChat / buscarMensagensConversa) para cair no select mínimo sem quebrar o
 * endpoint. Superset seguro: cobre todas as colunas opcionais desses selects; o select
 * de fallback é sempre um subconjunto delas. Preserva o contrato original (só `message`);
 * é distinto de isMissingMensagemColumnError(error, columnName), que checa uma coluna.
 */
function isMensagemColumnFallbackError(error) {
  const msg = String(error?.message || '')
  return (
    msg.includes('reply_meta') ||
    msg.includes('remetente_nome') ||
    msg.includes('remetente_telefone') ||
    msg.includes('contact_meta') ||
    msg.includes('location_meta') ||
    msg.includes('apagada_para_todos') ||
    msg.includes('audio_duracao_sec') ||
    msg.includes('client_temp_id') ||
    msg.includes('does not exist')
  )
}

function parseChatListPagination(query = {}, env = process.env) {
  const maxLimit = Math.max(1, parsePositiveInt(env.CHAT_LIST_MAX_LIMIT, 250))
  const defaultLimit = Math.min(maxLimit, Math.max(1, parsePositiveInt(env.CHAT_LIST_DEFAULT_LIMIT, 100)))
  const requestedLimit = query.limit ?? query.per_page ?? query.page_size
  const limit = Math.min(maxLimit, Math.max(1, parsePositiveInt(requestedLimit, defaultLimit)))
  const cursor =
    query.cursor != null && String(query.cursor).trim() !== ''
      ? String(query.cursor).trim()
      : query.cursor_ultima_atividade != null && String(query.cursor_ultima_atividade).trim() !== ''
        ? String(query.cursor_ultima_atividade).trim()
        : null
  const cursorIdRaw = query.cursor_id ?? query.next_cursor_id
  const cursorId =
    cursorIdRaw != null && String(cursorIdRaw).trim() !== '' && Number.isFinite(Number(cursorIdRaw))
      ? Math.floor(Number(cursorIdRaw))
      : null
  const responseMode = String(query.response_mode || '').trim().toLowerCase()
  const paginatedResponse =
    parseBooleanQuery(query.paginated) ||
    responseMode === 'paginated' ||
    responseMode === 'pagination' ||
    responseMode === 'object'
  return { limit, cursor, cursor_id: cursorId, paginatedResponse, maxLimit, defaultLimit }
}

function applyChatListCursor(query, cursorUltimaAtividade, cursorIdRaw) {
  const cursor = cursorUltimaAtividade != null && String(cursorUltimaAtividade).trim() !== ''
    ? String(cursorUltimaAtividade).trim()
    : null
  if (!cursor) return query
  const idNum =
    cursorIdRaw !== undefined && cursorIdRaw !== null && String(cursorIdRaw).trim() !== ''
      ? Number(cursorIdRaw)
      : NaN
  if (Number.isFinite(idNum)) {
    const quoted = `"${cursor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    return query.or(`ultima_atividade.lt.${quoted},and(ultima_atividade.eq.${quoted},id.lt.${Math.floor(idNum)})`)
  }
  return query.lt('ultima_atividade', cursor)
}

function splitChatListPage(rows = [], limit = 100) {
  const safeRows = Array.isArray(rows) ? rows : []
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 100))
  const hasMore = safeRows.length > safeLimit
  const pageRows = safeRows.slice(0, safeLimit)
  const last = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null
  const nextCursor = hasMore && last ? (last.ultima_atividade || last.criado_em || null) : null
  const nextCursorId = hasMore && last && last.id != null ? Number(last.id) : null
  return {
    rows: pageRows,
    pagination: {
      limit: safeLimit,
      has_more: hasMore,
      next_cursor: nextCursor,
      next_cursor_id: Number.isFinite(nextCursorId) ? nextCursorId : null,
    },
  }
}

function parseMessageHistoryPagination(query = {}, env = process.env) {
  const maxLimit = Math.max(1, parsePositiveInt(env.MESSAGE_HISTORY_MAX_LIMIT, 250))
  const defaultLimit = Math.min(maxLimit, Math.max(1, parsePositiveInt(env.MESSAGE_HISTORY_DEFAULT_LIMIT, 100)))
  const requestedLimit = query.limit ?? query.per_page ?? query.page_size
  const limit = Math.min(maxLimit, Math.max(1, parsePositiveInt(requestedLimit, defaultLimit)))
  const cursor = query.cursor != null && String(query.cursor).trim() !== '' ? String(query.cursor).trim() : null
  const cursorIdRaw = query.cursor_id ?? query.next_cursor_id
  const cursorId =
    cursorIdRaw != null && String(cursorIdRaw).trim() !== '' && Number.isFinite(Number(cursorIdRaw))
      ? Math.floor(Number(cursorIdRaw))
      : null
  return { limit, cursor, cursor_id: cursorId, maxLimit, defaultLimit }
}

function splitMessageHistoryPage(rows = [], limit = 100) {
  const safeRows = Array.isArray(rows) ? rows : []
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 100))
  const hasMore = safeRows.length > safeLimit
  const pageRows = safeRows.slice(0, safeLimit)
  const oldestRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null
  return {
    rows: pageRows,
    has_more: hasMore,
    cursor_row: oldestRow,
  }
}

function shouldIncludeClientesSemConversa({ incluirTodosClientesAtivo, palavraTrim }) {
  return Boolean(incluirTodosClientesAtivo && palavraTrim && String(palavraTrim).trim())
}

function setChatListPaginationHeaders(res, pagination, extra = {}) {
  if (!res || typeof res.set !== 'function') return
  res.set('X-Chat-List-Limit', String(pagination.limit))
  res.set('X-Chat-List-Has-More', pagination.has_more ? '1' : '0')
  if (pagination.next_cursor) res.set('X-Chat-List-Next-Cursor', String(pagination.next_cursor))
  if (pagination.next_cursor_id != null) res.set('X-Chat-List-Next-Cursor-Id', String(pagination.next_cursor_id))
  if (extra.totalCount != null && Number.isFinite(Number(extra.totalCount))) {
    res.set('X-Chat-List-Total-Count', String(Math.max(0, Math.floor(Number(extra.totalCount)))))
  }
  if (extra.semConversaIncluded != null) {
    res.set('X-Chat-List-Sem-Conversa-Included', extra.semConversaIncluded ? '1' : '0')
  }
  const expose = ['X-Chat-List-Limit', 'X-Chat-List-Has-More', 'X-Chat-List-Next-Cursor', 'X-Chat-List-Next-Cursor-Id', 'X-Chat-List-Total-Count', 'X-Chat-List-Sem-Conversa-Included']
  res.set('Access-Control-Expose-Headers', expose.join(', '))
}

function ordenarMensagensHistoricoAsc(a, b) {
  const ta = new Date(a?.criado_em || 0).getTime()
  const tb = new Date(b?.criado_em || 0).getTime()
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
  const ida = Number(a?.atendimento_id ?? a?.id)
  const idb = Number(b?.atendimento_id ?? b?.id)
  if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return ida - idb
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

/** Enriquece mensagens com usuario_id, usuario_nome e enviado_por_usuario (apenas direcao out) */
function textoRevogadoApagadaParaTodos(m, viewerUserId) {
  const souAutor =
    m?.autor_usuario_id != null &&
    viewerUserId != null &&
    Number(m.autor_usuario_id) === Number(viewerUserId)
  return souAutor ? 'Você apagou esta mensagem para todos.' : 'Esta mensagem foi apagada para todos.'
}

function aplicarApagadaParaTodosNaMensagem(m, viewerUserId) {
  if (!m?.apagada_para_todos) return m
  return {
    ...m,
    apagada_para_todos: true,
    texto: textoRevogadoApagadaParaTodos(m, viewerUserId),
    reply_meta: null,
    mensagem_respondida_id: null,
  }
}

async function enrichMensagensComAutorUsuario(supabase, company_id, mensagens, viewerUserId = null) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return mensagens
  const autorIds = [...new Set(mensagens.map((m) => m.autor_usuario_id).filter(Boolean))]
  const decorate = (m, usuarioNome) => {
    let row = {
      ...m,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(m.criado_em),
      usuario_id: m.autor_usuario_id ?? null,
      usuario_nome: usuarioNome,
      enviado_por_usuario: m.direcao === 'out' && m.autor_usuario_id != null,
    }
    if (viewerUserId != null) row = aplicarApagadaParaTodosNaMensagem(row, viewerUserId)
    return row
  }
  if (autorIds.length === 0) return mensagens.map((m) => decorate(m, null))
  const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
  const usuarioMap = new Map((us || []).map((u) => [u.id, u.nome]))
  return mensagens.map((m) =>
    decorate(
      m,
      m.direcao === 'out' && m.autor_usuario_id ? (usuarioMap.get(m.autor_usuario_id) ?? null) : null
    )
  )
}

async function assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_ids }) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone, status_atendimento')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  const isGroup = isGroupConversation(conv)
  const r = String(role || '').toLowerCase()
  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  const depIds = Array.isArray(user_dep_ids) ? user_dep_ids : []

  // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE permitir acesso total
  if (!isGroup && isAssignedToUser) return { ok: true, conv, reason: 'conversa_assumida_pelo_usuario' }
  if (!isGroup && conv.atendente_id && await usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, user_id)) {
    return { ok: true, conv, reason: 'usuario_participante_conversa' }
  }
  if (r === 'admin') return { ok: true, conv }

  // EXCEÇÃO: usuário transferiu a conversa para outro — vê independente do setor
  const { data: transferRow } = await supabase
    .from('atendimentos')
    .select('id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('de_usuario_id', Number(user_id))
    .eq('acao', 'transferiu')
    .limit(1)
    .maybeSingle()
  if (!isGroup && transferRow) return { ok: true, conv, reason: 'usuario_transferiu_conversa' }

  // Encerrada: qualquer atendente/supervisor pode reabrir (ex.: quem finalizou em outro setor).
  if (!isGroup && (r === 'supervisor' || r === 'atendente') && isClosedAttendanceStatus(conv.status_atendimento)) {
    return { ok: true, conv, reason: 'conversa_encerrada_reabertura' }
  }

  // supervisor e atendente: conversas sem setor visíveis para TODOS; com setor só se usuário pertence
  if (r === 'supervisor' || r === 'atendente') {
    if (isGroup) {
      const podeVerGrupo = await usuarioPodeVerGrupo({
        company_id,
        conversa_id,
        role,
        departamento_ids: depIds,
      })
      if (!podeVerGrupo) {
        return { ok: false, status: 403, error: 'Grupo nao vinculado ao seu setor' }
      }
    } else {
      const convDep = conv.departamento_id ?? null
      const userSemSetor = depIds.length === 0
      if (userSemSetor && convDep != null) return { ok: false, status: 403, error: 'Conversa de outro setor' }
      if (convDep != null && !depIds.some((id) => Number(id) === Number(convDep))) return { ok: false, status: 403, error: 'Conversa de outro setor' }
    }
    return { ok: true, conv }
  }

  return { ok: true, conv }
}

// =====================================================
// 2) UNREAD (TotalChat-like)
// =====================================================
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

function getSearchMessagesPageSize() {
  const raw = Number(process.env.CHAT_SEARCH_MESSAGES_PAGE_SIZE)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}

function getChatSearchScanLimit() {
  const raw = Number(process.env.CHAT_SEARCH_SCAN_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 2000)
}

function getChatSearchIdLimit() {
  const raw = Number(process.env.CHAT_SEARCH_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 3000)
}

function getChatFilterIdLimit() {
  const raw = Number(process.env.CHAT_FILTER_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}

function getConversaMessagesSearchLimit(rawLimit) {
  const raw = Number(rawLimit)
  if (!Number.isFinite(raw) || raw <= 0) return 30
  return Math.min(Math.max(Math.floor(raw), 1), 100)
}

async function buscarConversaIdsPorTextoMensagens({ company_id, term }) {
  const pageSize = getSearchMessagesPageSize()
  const scanLimit = getChatSearchScanLimit()
  const idLimit = getChatSearchIdLimit()
  const ids = new Set()
  // term chega sem wildcards; construímos aqui para manter contrato uniforme com o service
  const likePattern = `%${escapeIlikePattern(term)}%`

  for (let start = 0; start < scanLimit && ids.size < idLimit; start += pageSize) {
    const end = Math.min(start + pageSize - 1, scanLimit - 1)
    const { data, error } = await supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', Number(company_id))
      .ilike('texto', likePattern)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .range(start, end)

    if (error) {
      console.warn('[busca-msg] erro na varredura de mensagens:', error.message)
      break
    }

    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      if (row?.conversa_id != null) ids.add(row.conversa_id)
      if (ids.size >= idLimit) break
    }

    if (rows.length < (end - start + 1)) break
  }

  return [...ids]
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

module.exports = {
  mergeConversaClienteTags,
  resolveTelefoneFromLidSiblingConversation,
  safeWhatsappInstanceMeta,
  loadWhatsappInstanceMetaMap,
  statusAtendimentoParaLista,
  applyDetalharChatMensagensCursor,
  parsePositiveInt,
  parseBooleanQuery,
  isFlagAtivo,
  isMensagemColumnFallbackError,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  ordenarMensagensHistoricoAsc,
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  assertPermissaoConversa,
  marcarComoLidaPorUsuario,
  obterUnreadMap,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
  buscarConversaIdsPorTextoMensagens,
  isConversaAtendentesMissingTable,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
}
