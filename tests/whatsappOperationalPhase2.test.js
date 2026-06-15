function createSupabaseConversationMock(seed = {}) {
  const state = {
    conversas: [...(seed.conversas || [])],
  }
  const calls = []

  function makeBuilder(table) {
    const q = {
      table,
      filters: [],
      orders: [],
      limitValue: null,
      mode: 'select',
      payload: null,
      selectFields: null,
      select(fields) {
        this.selectFields = fields
        return this
      },
      eq(field, value) {
        this.filters.push({ type: 'eq', field, value })
        return this
      },
      in(field, values) {
        this.filters.push({ type: 'in', field, values })
        return this
      },
      is(field, value) {
        this.filters.push({ type: 'is', field, value })
        return this
      },
      order(field, opts = {}) {
        this.orders.push({ field, ascending: opts.ascending !== false })
        return this
      },
      limit(value) {
        this.limitValue = Number(value)
        return this
      },
      insert(payload) {
        this.mode = 'insert'
        this.payload = payload
        return this
      },
      update(payload) {
        this.mode = 'update'
        this.payload = payload
        return this
      },
      single() {
        const rows = execute(this)
        return Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } })
      },
      maybeSingle() {
        const rows = execute(this)
        return Promise.resolve({ data: rows[0] || null, error: null })
      },
      then(resolve, reject) {
        return Promise.resolve({ data: execute(this), error: null }).then(resolve, reject)
      },
    }
    return q
  }

  function matches(row, filters) {
    return filters.every((f) => {
      if (f.type === 'in') return Array.isArray(f.values) && f.values.includes(row[f.field])
      if (f.type === 'is') return f.value === null ? row[f.field] == null : row[f.field] === f.value
      return row[f.field] === f.value
    })
  }

  function execute(q) {
    calls.push({ table: q.table, mode: q.mode, filters: q.filters, payload: q.payload })
    const rows = state[q.table] || []
    if (q.mode === 'insert') {
      const payload = { ...q.payload, id: q.payload.id || rows.length + 1, departamento_id: q.payload.departamento_id ?? null }
      rows.push(payload)
      return [payload]
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
        const res = av > bv ? 1 : -1
        return order.ascending ? res : -res
      })
    }
    if (q.limitValue != null) result = result.slice(0, q.limitValue)
    return result
  }

  return {
    state,
    calls,
    from: jest.fn((table) => makeBuilder(table)),
  }
}

describe('WhatsApp multi-instance operational phase 2', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('findOrCreateConversation escolhe conversa da instancia informada para o mesmo telefone', async () => {
    jest.doMock('../config/supabase', () => createSupabaseConversationMock())
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 1, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: 2, departamento_id: null },
        { id: 2, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: 3, departamento_id: null },
      ],
    })

    const result = await findOrCreateConversation(supabase, {
      company_id: 10,
      phone: '5534999999999',
      whatsapp_instance_id: 2,
      whatsapp_instance_is_default: false,
    })

    expect(result.created).toBe(false)
    expect(result.conversa.id).toBe(1)
  })

  test('nao reaproveita conversa legada null para instancia nao-default', async () => {
    jest.doMock('../config/supabase', () => createSupabaseConversationMock())
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 1, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: null, departamento_id: null },
      ],
    })

    const result = await findOrCreateConversation(supabase, {
      company_id: 10,
      phone: '5534999999999',
      whatsapp_instance_id: 3,
      whatsapp_instance_is_default: false,
    })

    expect(result.created).toBe(true)
    expect(result.conversa.whatsapp_instance_id).toBe(3)
    expect(supabase.state.conversas).toHaveLength(2)
  })

  test('reaproveita e preenche conversa legada null quando a instancia e default', async () => {
    jest.doMock('../config/supabase', () => createSupabaseConversationMock())
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 1, company_id: 10, telefone: '5534999999999', whatsapp_instance_id: null, departamento_id: null },
      ],
    })

    const result = await findOrCreateConversation(supabase, {
      company_id: 10,
      phone: '5534999999999',
      whatsapp_instance_id: 2,
      whatsapp_instance_is_default: true,
    })

    expect(result.created).toBe(false)
    expect(result.conversa.id).toBe(1)
    expect(supabase.state.conversas[0].whatsapp_instance_id).toBe(2)
  })

  test('resolveWebhookCompany injeta contexto da instancia sem tokens', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceByProviderInstanceId: jest.fn(async () => ({
        instance: {
          id: 7,
          company_id: 20,
          provider: 'ultramsg',
          instance_id: '777',
          is_default: false,
          instance_token: 'secret',
        },
        error: null,
      })),
    }))

    const middleware = require('../middleware/resolveWebhookCompany')
    const req = { method: 'POST', path: '/webhooks/ultramsg', body: { instanceId: '777', type: 'message_received' } }
    const res = { status: jest.fn(() => res), json: jest.fn() }
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.webhookContext).toMatchObject({
      company_id: 20,
      whatsapp_instance_id: 7,
      provider: 'ultramsg',
      provider_instance_id: '777',
    })
    expect(req.webhookContext.instance_token).toBeUndefined()
  })

  test('resolveWebhookCompany bloqueia duplicidade ativa sem chamar next', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceByProviderInstanceId: jest.fn(async () => ({
        instance: null,
        code: 'DUPLICATE_PROVIDER_INSTANCE',
        error: 'duplicidade ativa',
      })),
    }))

    const middleware = require('../middleware/resolveWebhookCompany')
    const req = { method: 'POST', path: '/webhooks/ultramsg', body: { instanceId: '777', type: 'message_received' } }
    const res = { status: jest.fn(() => res), json: jest.fn() }
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true, ignored: 'duplicate_provider_instance' })
    expect(req.webhookLogData.status).toBe('blocked_duplicate_instance')
  })
})
