const { _test } = require('../controllers/chatController')

describe('GET /api/chats pagination contract', () => {
  test('uses safe default limit and caps oversized requests', () => {
    expect(_test.parseChatListPagination({}, {
      CHAT_LIST_DEFAULT_LIMIT: '80',
      CHAT_LIST_MAX_LIMIT: '120',
    })).toMatchObject({
      limit: 80,
      maxLimit: 120,
      defaultLimit: 80,
    })

    expect(_test.parseChatListPagination({ limit: '9999' }, {
      CHAT_LIST_DEFAULT_LIMIT: '80',
      CHAT_LIST_MAX_LIMIT: '120',
    })).toMatchObject({
      limit: 120,
    })
  })

  test('trims limit + 1 rows and exposes cursor metadata', () => {
    const rows = [
      { id: 30, ultima_atividade: '2026-06-06T12:00:00.000Z' },
      { id: 20, ultima_atividade: '2026-06-06T11:00:00.000Z' },
      { id: 10, ultima_atividade: '2026-06-06T10:00:00.000Z' },
    ]

    const page = _test.splitChatListPage(rows, 2)

    expect(page.rows).toHaveLength(2)
    expect(page.pagination).toEqual({
      limit: 2,
      has_more: true,
      next_cursor: '2026-06-06T11:00:00.000Z',
      next_cursor_id: 20,
    })
  })

  test('next cursor comes from the SQL order, not from the JS-reordered page', () => {
    const { resolveChatListNextCursor, CHAT_LIST_SQL_INDEX: SQL_INDEX } = _test
    // Ordem do SQL: ultima_atividade DESC. Índice 2 é a fronteira real desta página.
    const sqlRows = [
      { id: 30, ultima_atividade: '2026-06-06T12:00:00.000Z' },
      { id: 20, ultima_atividade: '2026-06-06T11:00:00.000Z' },
      { id: 10, ultima_atividade: '2026-06-06T10:00:00.000Z' },
      { id: 5, ultima_atividade: '2026-06-06T09:00:00.000Z' },
    ]
    // Lista entregue já reordenada em JS (fixada no topo) — a última linha exibida é a de 11:00.
    const pageRows = [
      { id: 10, [SQL_INDEX]: 2, fixada: true },
      { id: 30, [SQL_INDEX]: 0 },
      { id: 20, [SQL_INDEX]: 1 },
    ]

    expect(resolveChatListNextCursor(pageRows, sqlRows, true, true)).toEqual({
      has_more: true,
      next_cursor: '2026-06-06T10:00:00.000Z',
      next_cursor_id: 10,
    })
  })

  test('next cursor uses the last consumed SQL row when nothing was truncated', () => {
    const { resolveChatListNextCursor, CHAT_LIST_SQL_INDEX: SQL_INDEX } = _test
    const sqlRows = [
      { id: 30, ultima_atividade: '2026-06-06T12:00:00.000Z' },
      { id: 20, ultima_atividade: '2026-06-06T11:00:00.000Z' },
    ]
    // Pós-filtros derrubaram a linha 20; ainda assim ela foi consumida do SQL.
    const pageRows = [{ id: 30, [SQL_INDEX]: 0 }]

    expect(resolveChatListNextCursor(pageRows, sqlRows, false, true)).toEqual({
      has_more: true,
      next_cursor: '2026-06-06T11:00:00.000Z',
      next_cursor_id: 20,
    })
  })

  test('stops paginating instead of emitting an unusable cursor', () => {
    const { resolveChatListNextCursor, CHAT_LIST_SQL_INDEX: SQL_INDEX } = _test
    const semMais = resolveChatListNextCursor([], [{ id: 1, ultima_atividade: null }], false, false)
    expect(semMais).toEqual({ has_more: false, next_cursor: null, next_cursor_id: null })

    // Cauda de ultima_atividade NULL: não há keyset válido (o cursor compara ultima_atividade).
    const semCursor = resolveChatListNextCursor(
      [{ id: 1, [SQL_INDEX]: 0 }],
      [{ id: 1, ultima_atividade: null, criado_em: '2026-06-06T10:00:00.000Z' }],
      false,
      true
    )
    expect(semCursor).toEqual({ has_more: false, next_cursor: null, next_cursor_id: null })
  })

  test('does not include clients without conversation by default or without search', () => {
    expect(_test.shouldIncludeClientesSemConversa({
      incluirTodosClientesAtivo: false,
      palavraTrim: '',
    })).toBe(false)

    expect(_test.shouldIncludeClientesSemConversa({
      incluirTodosClientesAtivo: true,
      palavraTrim: '',
    })).toBe(false)

    expect(_test.shouldIncludeClientesSemConversa({
      incluirTodosClientesAtivo: true,
      palavraTrim: 'maria',
    })).toBe(true)
  })

  test('supports object response opt-in without changing the default array mode', () => {
    expect(_test.parseChatListPagination({ paginated: '1' }).paginatedResponse).toBe(true)
    expect(_test.parseChatListPagination({ response_mode: 'paginated' }).paginatedResponse).toBe(true)
    expect(_test.parseChatListPagination({}).paginatedResponse).toBe(false)
  })

  test('caps intermediate search/filter scans used before chat pagination', () => {
    const oldEnv = { ...process.env }
    try {
      process.env.CHAT_SEARCH_MESSAGES_PAGE_SIZE = '999999'
      process.env.CHAT_SEARCH_SCAN_LIMIT = '999999'
      process.env.CHAT_SEARCH_ID_LIMIT = '999999'
      process.env.CHAT_FILTER_ID_LIMIT = '999999'

      expect(_test.getSearchMessagesPageSize()).toBe(5000)
      expect(_test.getChatSearchScanLimit()).toBe(2000)
      expect(_test.getChatSearchIdLimit()).toBe(3000)
      expect(_test.getChatFilterIdLimit()).toBe(5000)

      process.env.CHAT_SEARCH_MESSAGES_PAGE_SIZE = '10'
      process.env.CHAT_SEARCH_SCAN_LIMIT = '10'
      process.env.CHAT_SEARCH_ID_LIMIT = '10'
      process.env.CHAT_FILTER_ID_LIMIT = '10'

      expect(_test.getSearchMessagesPageSize()).toBe(100)
      expect(_test.getChatSearchScanLimit()).toBe(100)
      expect(_test.getChatSearchIdLimit()).toBe(100)
      expect(_test.getChatFilterIdLimit()).toBe(100)
    } finally {
      process.env = oldEnv
    }
  })

  test('uses safe message history page size and caps oversized requests', () => {
    expect(_test.parseMessageHistoryPagination({}, {
      MESSAGE_HISTORY_DEFAULT_LIMIT: '100',
      MESSAGE_HISTORY_MAX_LIMIT: '250',
    })).toMatchObject({
      limit: 100,
      maxLimit: 250,
      defaultLimit: 100,
    })

    expect(_test.parseMessageHistoryPagination({ limit: '9999' }, {
      MESSAGE_HISTORY_DEFAULT_LIMIT: '100',
      MESSAGE_HISTORY_MAX_LIMIT: '250',
    })).toMatchObject({
      limit: 250,
    })
  })

  test('trims message history limit + 1 rows and keeps oldest delivered row as cursor', () => {
    const rows = [
      { id: 30, criado_em: '2026-06-06T12:00:00.000Z' },
      { id: 20, criado_em: '2026-06-06T11:00:00.000Z' },
      { id: 10, criado_em: '2026-06-06T10:00:00.000Z' },
    ]

    const page = _test.splitMessageHistoryPage(rows, 2)

    expect(page.rows).toHaveLength(2)
    expect(page.has_more).toBe(true)
    expect(page.cursor_row).toEqual({ id: 20, criado_em: '2026-06-06T11:00:00.000Z' })
  })
})
