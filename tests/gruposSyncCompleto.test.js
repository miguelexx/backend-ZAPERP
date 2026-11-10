/**
 * "Faltam grupos no sistema" — as quatro perdas medidas em 10/11/2026 contra o canal e o banco
 * de produção:
 *
 *  1. Whapi pagina em 100: `GET /groups` e `GET /chats` sem `count` devolvem 100 itens
 *     (`{"count":100,"total":2}` / `{"count":1,"total":723}`). O resto da lista nunca chegava.
 *  2. Grupo de ID LEGADO (`<dono>-<criação>@g.us`) era descartado por `extractGroupFields`
 *     (exigia prefixo `120`) — "WM Sistemas de Gestão", 397 participantes, fora do sistema.
 *  3. A variante de busca `<dono>` do id legado casava com a conversa INDIVIDUAL do criador do
 *     grupo: o grupo não era criado e o telefone da conversa individual era reescrito.
 *  4. O sync só varria a instância DEFAULT — grupos dos outros números da empresa não entravam.
 */

// ---------------------------------------------------------------- 1) paginação Whapi

describe('Whapi — listagens completas (paginação por count/offset)', () => {
  let prevBase
  beforeEach(() => {
    jest.resetModules()
    prevBase = process.env.WHAPI_BASE_URL
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    if (prevBase === undefined) delete process.env.WHAPI_BASE_URL
    else process.env.WHAPI_BASE_URL = prevBase
    jest.resetModules()
  })

  function mockDeps(fetchImpl) {
    const fetchWithRetry = jest.fn(fetchImpl)
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: { id, company_id: companyId, provider: 'whapi', instance_id: 'CANAL', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }

  const jsonRes = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
  const CTX = { companyId: 1, whatsappInstanceId: 10 }
  const paramsOf = (url) => Object.fromEntries(new URL(url).searchParams.entries())

  test('getGroups percorre todas as páginas até cobrir o total informado', async () => {
    process.env.WHAPI_LIST_PAGE_SIZE = '2'
    const grupo = (n) => ({ id: `12036300000000000${n}@g.us`, name: `G${n}` })
    const { fetchWithRetry } = mockDeps(async (url) => {
      const { offset } = paramsOf(url)
      if (offset === '0') return jsonRes({ groups: [grupo(1), grupo(2)], count: 2, total: 5 })
      if (offset === '2') return jsonRes({ groups: [grupo(3), grupo(4)], count: 2, total: 5 })
      return jsonRes({ groups: [grupo(5)], count: 2, total: 5 })
    })
    const whapi = require('../services/providers/whapi')
    const groups = await whapi.getGroups(CTX)
    delete process.env.WHAPI_LIST_PAGE_SIZE

    expect(groups).toHaveLength(5)
    expect(groups.map((g) => g.name)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5'])
    expect(fetchWithRetry).toHaveBeenCalledTimes(3)
    // Sem `count`, a Whapi entregaria só os 100 primeiros: o parâmetro tem de ir em TODA página.
    expect(paramsOf(fetchWithRetry.mock.calls[0][0])).toEqual({ count: '2', offset: '0' })
    expect(paramsOf(fetchWithRetry.mock.calls[1][0])).toEqual({ count: '2', offset: '2' })
  })

  test('getChats pagina igual (723 chats não podem virar 100)', async () => {
    process.env.WHAPI_LIST_PAGE_SIZE = '2'
    const chat = (n) => ({ id: `55349900000${n}@s.whatsapp.net` })
    const { fetchWithRetry } = mockDeps(async (url) => {
      const { offset } = paramsOf(url)
      if (offset === '0') return jsonRes({ chats: [chat(1), chat(2)], total: 3 })
      return jsonRes({ chats: [chat(3)], total: 3 })
    })
    const whapi = require('../services/providers/whapi')
    const chats = await whapi.getChats(CTX)
    delete process.env.WHAPI_LIST_PAGE_SIZE

    expect(chats).toHaveLength(3)
    expect(fetchWithRetry).toHaveBeenCalledTimes(2)
    expect(new URL(fetchWithRetry.mock.calls[0][0]).pathname).toBe('/chats')
  })

  test('canal que ignora offset (página repetida) não gera laço infinito', async () => {
    process.env.WHAPI_LIST_PAGE_SIZE = '2'
    const grupo = (n) => ({ id: `12036300000000000${n}@g.us`, name: `G${n}` })
    const { fetchWithRetry } = mockDeps(async () => jsonRes({ groups: [grupo(1), grupo(2)], total: 99 }))
    const whapi = require('../services/providers/whapi')
    const groups = await whapi.getGroups(CTX)
    delete process.env.WHAPI_LIST_PAGE_SIZE

    expect(groups).toHaveLength(2)
    expect(fetchWithRetry).toHaveBeenCalledTimes(2) // 1ª página + 1 repetida detectada
  })

  test('count/offset explícitos continuam sendo UMA página (quem chama pagina sozinho)', async () => {
    const grupo = (n) => ({ id: `12036300000000000${n}@g.us`, name: `G${n}` })
    const { fetchWithRetry } = mockDeps(async () => jsonRes({ groups: [grupo(1)], total: 50 }))
    const whapi = require('../services/providers/whapi')
    const groups = await whapi.getGroups({ ...CTX, count: 1, offset: 7 })

    expect(groups).toHaveLength(1)
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    expect(paramsOf(fetchWithRetry.mock.calls[0][0])).toEqual({ count: '1', offset: '7' })
  })
})

// ------------------------------------------------- 2) id legado em extractGroupFields

describe('extractGroupFields — grupos de ID legado entram', () => {
  beforeEach(() => jest.resetModules())

  function load() {
    jest.doMock('../config/supabase', () => ({ from: jest.fn() }))
    return require('../services/ultramsgGroupsSyncService')
  }

  test('id legado <dono>-<criação>@g.us é aceito e mantém o hífen no telefone', () => {
    const { extractGroupFields } = load()
    expect(extractGroupFields({ id: '553484079741-1553807524@g.us', name: 'WM Sistemas de Gestão' })).toEqual({
      groupId: '553484079741-1553807524@g.us',
      // Mesmo formato que findOrCreateConversation grava — dígitos colados criariam linha dupla.
      telefone: '553484079741-1553807524',
      nome: 'WM Sistemas de Gestão',
      foto: null,
    })
  })

  test('id moderno 120…@g.us segue aceito', () => {
    const { extractGroupFields } = load()
    expect(extractGroupFields({ id: '120363424768062683@g.us', name: 'Teste' })?.telefone)
      .toBe('120363424768062683')
  })

  test('o que não é grupo continua recusado', () => {
    const { extractGroupFields } = load()
    expect(extractGroupFields({ id: '553484079741@s.whatsapp.net' })).toBeNull()
    expect(extractGroupFields({ id: 'abc@g.us' })).toBeNull()
    expect(extractGroupFields({ id: '12036@g.us' })).toBeNull()
    expect(extractGroupFields(null)).toBeNull()
  })
})

// --------------------------- 3) grupo legado não pode casar com a conversa do criador

let mockInstances = []
jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn(async () => ({ instances: mockInstances, error: null })),
}))

function createSupabaseConversationMock(seed = {}) {
  const state = { conversas: [...(seed.conversas || [])] }

  function matches(row, filters) {
    return filters.every((f) => {
      if (f.type === 'in') return Array.isArray(f.values) && f.values.includes(row[f.field])
      if (f.type === 'is') return f.value === null ? row[f.field] == null : row[f.field] === f.value
      if (f.type === 'neq') return row[f.field] !== f.value
      return row[f.field] === f.value
    })
  }

  function execute(q) {
    const rows = state[q.table] || []
    if (q.mode === 'insert') {
      const payload = { ...q.payload, id: q.payload.id || 1000 + rows.length, departamento_id: q.payload.departamento_id ?? null }
      rows.push(payload)
      return [payload]
    }
    if (q.mode === 'update') {
      for (const row of rows) if (matches(row, q.filters)) Object.assign(row, q.payload)
      return rows.filter((row) => matches(row, q.filters))
    }
    let result = rows.filter((row) => matches(row, q.filters))
    if (q.limitValue != null) result = result.slice(0, q.limitValue)
    return result
  }

  function makeBuilder(table) {
    const q = {
      table, filters: [], orders: [], limitValue: null, mode: 'select', payload: null,
      select() { return this },
      eq(f, v) { this.filters.push({ type: 'eq', field: f, value: v }); return this },
      neq(f, v) { this.filters.push({ type: 'neq', field: f, value: v }); return this },
      in(f, v) { this.filters.push({ type: 'in', field: f, values: v }); return this },
      is(f, v) { this.filters.push({ type: 'is', field: f, value: v }); return this },
      order(f, o = {}) { this.orders.push({ field: f, ascending: o.ascending !== false }); return this },
      limit(v) { this.limitValue = Number(v); return this },
      insert(p) { this.mode = 'insert'; this.payload = p; return this },
      update(p) { this.mode = 'update'; this.payload = p; return this },
      single() {
        const rows = execute(this)
        return Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } })
      },
      maybeSingle() { return Promise.resolve({ data: execute(this)[0] || null, error: null }) },
      then(resolve, reject) { return Promise.resolve({ data: execute(this), error: null }).then(resolve, reject) },
    }
    return q
  }

  return { state, from: jest.fn((table) => makeBuilder(table)) }
}

describe('Grupo legado × conversa individual do criador', () => {
  beforeEach(() => { mockInstances = [{ id: 1, ativo: true, is_default: true }] })

  test('grupo <dono>-<criação> NÃO casa com a conversa individual do dono — cria o grupo', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    // Empresa 1 em produção: conversa 452 é o INDIVIDUAL 553484079741, que é o dono do grupo.
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 452, company_id: 1, telefone: '553484079741', tipo: 'cliente', whatsapp_instance_id: 1, cliente_id: 9 },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '553484079741-1553807524@g.us',
      isGroup: true,
      nomeGrupo: 'WM Sistemas de Gestão',
      whatsapp_instance_id: 1,
      whatsapp_instance_is_default: true,
    })

    expect(r.created).toBe(true)
    expect(r.conversa.id).not.toBe(452)
    const grupo = supabase.state.conversas.find((c) => c.tipo === 'grupo')
    expect(grupo).toMatchObject({ telefone: '553484079741-1553807524', nome_grupo: 'WM Sistemas de Gestão' })
    // E a conversa individual fica INTACTA (antes o needsGroupUpdate reescrevia o telefone dela).
    expect(supabase.state.conversas.find((c) => c.id === 452).telefone).toBe('553484079741')
  })

  test('conversa individual não casa com linha de grupo do mesmo prefixo', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 500, company_id: 1, telefone: '553484079741-1553807524', tipo: 'grupo', whatsapp_instance_id: 1 },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '553484079741',
      cliente_id: 9,
      isGroup: false,
      whatsapp_instance_id: 1,
      whatsapp_instance_is_default: true,
    })

    expect(r.created).toBe(true)
    expect(r.conversa.id).not.toBe(500)
  })

  test('grupo já existente continua sendo reaproveitado (não duplica)', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 700, company_id: 1, telefone: '120363424768062683', tipo: 'grupo', whatsapp_instance_id: 1 },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '120363424768062683@g.us',
      isGroup: true,
      whatsapp_instance_id: 1,
      whatsapp_instance_is_default: true,
    })

    expect(r.created).toBe(false)
    expect(r.conversa.id).toBe(700)
    expect(supabase.state.conversas).toHaveLength(1)
  })
})

// ------------------------------------------- 4) sync varre TODOS os números da empresa

describe('syncGroups — todos os números ativos da empresa', () => {
  beforeEach(() => jest.resetModules())

  function montar({ instances, gruposPorInstancia }) {
    const conversas = []
    const supabase = {
      from: () => {
        const q = {
          filters: {}, _in: null, _mode: 'select', _payload: null,
          select() { return q },
          eq(f, v) { q.filters[f] = v; return q },
          in(f, v) { q._in = { f, v }; return q },
          order() { return q },
          limit() { return q },
          update(p) { q._mode = 'update'; q._payload = p; return q },
          then(resolve) {
            if (q._mode === 'update') return Promise.resolve({ data: null, error: null }).then(resolve)
            const achados = conversas.filter((c) => (q._in ? q._in.v.includes(c[q._in.f]) : true))
            return Promise.resolve({ data: achados, error: null }).then(resolve)
          },
        }
        return q
      },
    }

    const chamadas = []
    jest.doMock('../config/supabase', () => supabase)
    jest.doMock('../services/whatsappInstanceService', () => ({
      listWhatsappInstances: jest.fn(async () => ({ instances, error: null })),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveCompanyWhatsappProvider: jest.fn(async () => 'whapi'),
    }))
    jest.doMock('../services/whatsappConfigService', () => ({
      getEmpresaWhatsappConfig: jest.fn(async () => ({ config: { instance_id: 'x' }, error: null })),
    }))
    jest.doMock('../services/providers', () => ({
      getProvider: jest.fn(() => ({
        getGroups: jest.fn(async (opts) => {
          chamadas.push(opts.whatsappInstanceId ?? null)
          return gruposPorInstancia[opts.whatsappInstanceId] || []
        }),
        getGroup: jest.fn(async () => null),
        getProfilePicture: jest.fn(async () => null),
      })),
    }))
    jest.doMock('../helpers/conversationSync', () => ({
      findOrCreateConversation: jest.fn(async (_sb, args) => {
        const conv = { id: 2000 + conversas.length, telefone: String(args.phone).replace(/@g\.us$/i, ''), tipo: 'grupo' }
        conversas.push(conv)
        return { conversa: conv, created: true }
      }),
      getOrCreateCliente: jest.fn(async () => ({ cliente_id: 1 })),
    }))
    jest.doMock('../helpers/phoneHelper', () => ({ normalizePhoneBR: (p) => p }))

    return { chamadas, conversas, syncGroups: require('../services/ultramsgGroupsSyncService').syncGroups }
  }

  test('empresa com 2 números: busca os grupos de cada um', async () => {
    const { chamadas, conversas, syncGroups } = montar({
      instances: [
        { id: 25, provider: 'whapi', ativo: true, is_default: true },
        { id: 26, provider: 'whapi', ativo: true, is_default: false },
      ],
      gruposPorInstancia: {
        25: [{ id: '120363000000000001@g.us', name: 'Do número 25' }],
        26: [{ id: '120363000000000002@g.us', name: 'Do número 26' }],
      },
    })

    const r = await syncGroups(25)

    expect(r.ok).toBe(true)
    expect(chamadas).toEqual([25, 26]) // antes só a instância default era consultada
    expect(r.totalFetched).toBe(2)
    expect(r.inserted).toBe(2)
    expect(conversas.map((c) => c.telefone).sort()).toEqual(['120363000000000001', '120363000000000002'])
  })

  test('instância inativa fica de fora', async () => {
    const { chamadas, syncGroups } = montar({
      instances: [
        { id: 25, provider: 'whapi', ativo: true, is_default: true },
        { id: 26, provider: 'whapi', ativo: false, is_default: false },
      ],
      gruposPorInstancia: { 25: [], 26: [{ id: '120363000000000002@g.us', name: 'x' }] },
    })

    await syncGroups(25)
    expect(chamadas).toEqual([25])
  })

  test('sem tabela de instâncias, cai na instância default (comportamento antigo)', async () => {
    const { chamadas, syncGroups } = montar({
      instances: [],
      gruposPorInstancia: { undefined: [], null: [] },
    })

    const r = await syncGroups(7)
    expect(r.ok).toBe(true)
    expect(chamadas).toEqual([null]) // provider resolve a default, como antes
  })

  test('falha de um número não derruba o sync do outro', async () => {
    const conversas = []
    jest.doMock('../config/supabase', () => ({
      from: () => {
        const q = {
          select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, update: () => q,
          then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
        }
        return q
      },
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      listWhatsappInstances: jest.fn(async () => ({
        instances: [
          { id: 1, provider: 'whapi', ativo: true, is_default: true },
          { id: 2, provider: 'whapi', ativo: true, is_default: false },
        ],
        error: null,
      })),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveCompanyWhatsappProvider: jest.fn(async () => 'whapi'),
    }))
    jest.doMock('../services/whatsappConfigService', () => ({
      getEmpresaWhatsappConfig: jest.fn(async () => ({ config: {}, error: null })),
    }))
    jest.doMock('../services/providers', () => ({
      getProvider: jest.fn(() => ({
        getGroups: jest.fn(async (opts) => {
          if (opts.whatsappInstanceId === 1) throw new Error('canal fora do ar')
          return [{ id: '120363000000000002@g.us', name: 'Do número 2' }]
        }),
        getGroup: jest.fn(async () => null),
        getProfilePicture: jest.fn(async () => null),
      })),
    }))
    jest.doMock('../helpers/conversationSync', () => ({
      findOrCreateConversation: jest.fn(async (_sb, args) => {
        conversas.push(args.phone)
        return { conversa: { id: 1, telefone: args.phone }, created: true }
      }),
      getOrCreateCliente: jest.fn(async () => ({ cliente_id: 1 })),
    }))
    jest.doMock('../helpers/phoneHelper', () => ({ normalizePhoneBR: (p) => p }))

    const { syncGroups } = require('../services/ultramsgGroupsSyncService')
    const r = await syncGroups(1)

    expect(r.ok).toBe(true)
    expect(r.inserted).toBe(1)
    expect(r.errors.join(' ')).toContain('canal fora do ar')
    expect(conversas).toEqual(['120363000000000002@g.us'])
  })
})
