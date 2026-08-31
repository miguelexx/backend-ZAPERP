/**
 * Funções puras de paginação/cursor da listagem de conversas e do histórico de mensagens.
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 */

function parsePositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function parseBooleanQuery(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true'
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

module.exports = {
  parsePositiveInt,
  parseBooleanQuery,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  applyDetalharChatMensagensCursor,
}
