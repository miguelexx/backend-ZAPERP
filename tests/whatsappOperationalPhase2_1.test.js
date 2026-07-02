const fs = require('fs')
const path = require('path')

function createSupabaseMock(seed = {}) {
  const state = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))
  const calls = []

  function matches(row, filters) {
    return filters.every((f) => {
      const value = row[f.field]
      if (f.type === 'eq') return value === f.value
      if (f.type === 'is') return f.value === null ? value == null : value === f.value
      if (f.type === 'in') return Array.isArray(f.values) && f.values.includes(value)
      if (f.type === 'neq') return value !== f.value
      if (f.type === 'gte') return value >= f.value
      if (f.type === 'lte') return value <= f.value
      if (f.type === 'ilike') {
        const prefix = String(f.value || '').replace(/%$/, '').toLowerCase()
        return String(value || '').toLowerCase().startsWith(prefix)
      }
      return true
    })
  }

  function execute(q) {
    calls.push({ table: q.table, mode: q.mode, filters: [...q.filters], payload: q.payload })
    const rows = state[q.table] || (state[q.table] = [])

    if (q.mode === 'insert') {
      const payload = Array.isArray(q.payload) ? q.payload[0] : q.payload
      const row = { ...payload, id: payload.id || rows.length + 1 }
      rows.push(row)
      return [row]
    }

    if (q.mode === 'update') {
      const updated = []
      for (const row of rows) {
        if (matches(row, q.filters)) {
          Object.assign(row, q.payload)
          updated.push(row)
        }
      }
      return updated
    }

    let result = rows.filter((row) => matches(row, q.filters))
    for (const order of q.orders) {
      result = [...result].sort((a, b) => {
        const av = a[order.field]
        const bv = b[order.field]
        if (av === bv) return 0
        const dir = av > bv ? 1 : -1
        return order.ascending ? dir : -dir
      })
    }
    if (q.limitValue != null) result = result.slice(0, q.limitValue)
    return result
  }

  function makeBuilder(table) {
    const q = {
      table,
      mode: 'select',
      payload: null,
      filters: [],
      orders: [],
      limitValue: null,
      select() { return this },
      insert(payload) { this.mode = 'insert'; this.payload = payload; return this },
      update(payload) { this.mode = 'update'; this.payload = payload; return this },
      eq(field, value) { this.filters.push({ type: 'eq', field, value }); return this },
      is(field, value) { this.filters.push({ type: 'is', field, value }); return this },
      in(field, values) { this.filters.push({ type: 'in', field, values }); return this },
      neq(field, value) { this.filters.push({ type: 'neq', field, value }); return this },
      gte(field, value) { this.filters.push({ type: 'gte', field, value }); return this },
      lte(field, value) { this.filters.push({ type: 'lte', field, value }); return this },
      ilike(field, value) { this.filters.push({ type: 'ilike', field, value }); return this },
      order(field, opts = {}) { this.orders.push({ field, ascending: opts.ascending !== false }); return this },
      limit(value) { this.limitValue = Number(value); return this },
      maybeSingle() {
        const rows = execute(this)
        if (rows.length > 1) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } })
        return Promise.resolve({ data: rows[0] || null, error: null })
      },
      single() {
        const rows = execute(this)
        return Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } })
      },
      then(resolve, reject) {
        return Promise.resolve({ data: execute(this), error: null }).then(resolve, reject)
      },
    }
    return q
  }

  return {
    state,
    calls,
    from: jest.fn((table) => makeBuilder(table)),
  }
}

function mockControllerDeps(supabase, providerOverrides = {}) {
  const provider = {
    sendReaction: jest.fn(async () => true),
    removeReaction: jest.fn(async () => true),
    sendCall: jest.fn(async () => ({ ok: true, messageId: 'wamid.call-1' })),
    ...providerOverrides,
  }

  jest.doMock('../config/supabase', () => supabase)
  jest.doMock('../services/providers', () => ({ getProvider: () => provider }))
  jest.doMock('../services/whatsappInstanceService', () => ({
    getDefaultWhatsappInstance: jest.fn(async (companyId) => ({ instance: { id: 99, company_id: companyId }, error: null })),
    getWhatsappInstanceByProviderInstanceId: jest.fn(),
  }))
  jest.doMock('../services/ultramsgSyncContact', () => ({ syncUltraMsgContact: jest.fn() }))
  jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
  jest.doMock('../services/ultramsgIntegrationService', () => ({ getStatus: jest.fn() }))
  jest.doMock('../services/webPushDispatchService', () => ({ scheduleInboundWebPush: jest.fn() }))
  jest.doMock('../services/inboundMediaPersistenceService', () => ({
    schedulePersistInboundMediaIfNeeded: jest.fn(),
    tipoQualificaPersistencia: jest.fn(() => false),
  }))
  jest.doMock('../services/chatbotTriageService', () => ({ processIncomingMessage: jest.fn(), logBotAction: jest.fn() }))
  jest.doMock('../helpers/chatbotRealtimeEmitter', () => ({ emitBotMensagemRealtime: jest.fn(), emitReaberturaSemSetorRealtime: jest.fn() }))
  jest.doMock('../services/optOutService', () => ({ processarOptOut: jest.fn() }))
  jest.doMock('../services/regrasAutomaticasService', () => ({ processarRegras: jest.fn() }))
  jest.doMock('../services/absenceFinalizationService', () => ({
    tryMarkWaitingAfterHumanOutbound: jest.fn(async () => null),
    loadChatbotTriageMergeAndAbsence: jest.fn(),
    clearWaitingForClient: jest.fn(),
    fetchLastAbsenceEncerramentoSnap: jest.fn(),
    resolveReopenAssignmentAfterAbsence: jest.fn(),
  }))
  jest.doMock('../services/avaliacaoService', () => ({ parseNota: jest.fn(), tentarRegistrarAvaliacao: jest.fn() }))
  jest.doMock('../helpers/featureFlags', () => ({ isEnabled: jest.fn(() => false), FLAGS: {} }))

  return provider
}

function createReqRes({ params = {}, body = {} } = {}) {
  const emit = jest.fn()
  const io = { to: jest.fn(() => io), emit, EVENTS: { NOVA_MENSAGEM: 'nova_mensagem' } }
  const req = {
    user: { company_id: 10, id: 5, perfil: 'admin' },
    params,
    body,
    app: { get: jest.fn(() => io) },
  }
  const res = {
    statusCode: 200,
    status: jest.fn(function status(code) { this.statusCode = code; return this }),
    json: jest.fn(function json(payload) { this.payload = payload; return this }),
  }
  return { req, res, io }
}

describe('WhatsApp multi-instance operational phase 2.1', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  test('ACK/status atualiza somente a mensagem da instancia informada', async () => {
    const supabase = createSupabaseMock({
      mensagens: [
        { id: 1, company_id: 10, whatsapp_instance_id: 1, whatsapp_id: 'same-wa-id', status: 'pending' },
        { id: 2, company_id: 10, whatsapp_instance_id: 2, whatsapp_id: 'same-wa-id', status: 'pending' },
      ],
    })
    mockControllerDeps(supabase)
    const { _test } = require('../controllers/webhookZapiController')

    const { data, error } = await _test.updateSingleMensagemByWhatsappId(supabase, {
      company_id: 10,
      whatsapp_instance_id: 2,
      whatsapp_id: 'same-wa-id',
      updates: { status: 'delivered' },
      select: 'id, status',
      context: 'test.status',
    })

    expect(error).toBeNull()
    expect(data.id).toBe(2)
    expect(supabase.state.mensagens[0].status).toBe('pending')
    expect(supabase.state.mensagens[1].status).toBe('delivered')
  })

  test('fallback legado atualiza somente mensagem sem whatsapp_instance_id', async () => {
    const supabase = createSupabaseMock({
      mensagens: [
        { id: 1, company_id: 10, whatsapp_instance_id: null, whatsapp_id: 'legacy-wa-id', status: 'pending' },
        { id: 2, company_id: 10, whatsapp_instance_id: 2, whatsapp_id: 'legacy-wa-id', status: 'pending' },
      ],
    })
    mockControllerDeps(supabase)
    const { _test } = require('../controllers/webhookZapiController')

    const { data } = await _test.updateSingleMensagemByWhatsappId(supabase, {
      company_id: 10,
      whatsapp_id: 'legacy-wa-id',
      updates: { status: 'read' },
      select: 'id, status',
      context: 'test.legacy',
    })

    expect(data.id).toBe(1)
    expect(supabase.state.mensagens[0].status).toBe('read')
    expect(supabase.state.mensagens[1].status).toBe('pending')
  })

  test('resolver de status bloqueia duplicidade em vez de escolher primeira mensagem', async () => {
    const supabase = createSupabaseMock({
      mensagens: [
        { id: 1, company_id: 10, whatsapp_instance_id: null, whatsapp_id: 'dup-wa-id', status: 'pending' },
        { id: 2, company_id: 10, whatsapp_instance_id: null, whatsapp_id: 'dup-wa-id', status: 'pending' },
      ],
    })
    mockControllerDeps(supabase)
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { _test } = require('../controllers/webhookZapiController')

    const { data, error, ambiguous } = await _test.updateSingleMensagemByWhatsappId(supabase, {
      company_id: 10,
      whatsapp_id: 'dup-wa-id',
      updates: { status: 'delivered' },
      context: 'test.ambiguous',
    })

    expect(data).toBeNull()
    expect(error.code).toBe('AMBIGUOUS_WHATSAPP_ID')
    expect(ambiguous).toBe(true)
    expect(supabase.state.mensagens.every((m) => m.status === 'pending')).toBe(true)
    expect(consoleSpy).toHaveBeenCalled()
  })

  test('sendReaction usa a instancia vinculada a conversa', async () => {
    const supabase = createSupabaseMock({
      conversas: [{ id: 20, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: 7, atendente_id: 5, status_atendimento: 'em_atendimento' }],
      mensagens: [{ id: 30, company_id: 10, conversa_id: 20, whatsapp_id: 'wamid.msg-1' }],
    })
    const provider = mockControllerDeps(supabase)
    const controller = require('../controllers/chatController')
    const { req, res } = createReqRes({ params: { id: 20, mensagem_id: 30 }, body: { reaction: '+1' } })

    await controller.enviarReacaoMensagem(req, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(provider.sendReaction).toHaveBeenCalledWith('5534999999999', 'wamid.msg-1', '+1', {
      companyId: 10,
      whatsappInstanceId: 7,
    })
  })

  test('sendCall retorna erro claro sem criar mensagem nem chamar provider', async () => {
    const supabase = createSupabaseMock({
      conversas: [{ id: 20, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: 8, atendente_id: 5, status_atendimento: 'em_atendimento' }],
      mensagens: [],
    })
    const provider = mockControllerDeps(supabase)
    const controller = require('../controllers/chatController')
    const { req, res } = createReqRes({ params: { id: 20 }, body: { callDuration: 4 } })

    await controller.enviarLigacaoWhatsapp(req, res)

    expect(res.status).toHaveBeenCalledWith(501)
    expect(provider.sendCall).not.toHaveBeenCalled()
    expect(supabase.state.mensagens).toHaveLength(0)
  })

  test('migration de unicidade permite mesmo whatsapp_id em instancias diferentes e preserva legado', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260615003000_whatsapp_instances_phase2_1_messages_unique.sql'),
      'utf8'
    )
    const precheck = fs.readFileSync(
      path.join(__dirname, '../supabase/prechecks/20260615003000_whatsapp_instances_phase2_1_messages_unique_precheck.sql'),
      'utf8'
    )

    expect(migration).toContain('idx_mensagens_company_instance_whatsapp_id_unique')
    expect(migration).toContain('on public.mensagens (company_id, whatsapp_instance_id, whatsapp_id)')
    expect(migration).toContain('where whatsapp_instance_id is not null')
    expect(migration).toContain('idx_mensagens_company_whatsapp_id_legacy_null_unique')
    expect(migration).toContain('where whatsapp_instance_id is null')
    expect(migration).toContain('drop index if exists public.idx_mensagens_company_whatsapp_id')
    expect(precheck).toContain('having count(*) > 1')
  })

  test('migration de conversas permite mesmo telefone em instancias diferentes e preserva legado', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260615005000_whatsapp_instances_conversas_unique.sql'),
      'utf8'
    )
    const precheck = fs.readFileSync(
      path.join(__dirname, '../supabase/prechecks/20260615005000_whatsapp_instances_conversas_unique_precheck.sql'),
      'utf8'
    )
    const production = fs.readFileSync(
      path.join(__dirname, '../supabase/production/20260615005000_whatsapp_instances_conversas_unique_concurrently.sql'),
      'utf8'
    )

    expect(migration).toContain('idx_conversas_company_instance_telefone_unique')
    expect(migration).toContain('on public.conversas (company_id, whatsapp_instance_id, telefone)')
    expect(migration).toContain('where whatsapp_instance_id is not null')
    expect(migration).toContain('idx_conversas_company_telefone_legacy_null_unique')
    expect(migration).toContain('where whatsapp_instance_id is null')
    expect(migration).toContain('drop index if exists public.idx_conversas_company_telefone')
    expect(migration).toContain('idx_conversas_company_instance_chat_lid_unique')
    expect(precheck).toContain('DUPLICIDADE_INSTANCE_TELEFONE')
    expect(precheck).toContain('DUPLICIDADE_LEGADO_TELEFONE_NULL_INSTANCE')
    expect(production).toContain('create unique index concurrently')
  })
})
