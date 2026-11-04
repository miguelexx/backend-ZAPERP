/**
 * Regressão do "histórico some ao reabrir no dia seguinte": em empresa de INSTÂNCIA ÚNICA ativa
 * (sem is_default marcado), o inbound deve ADOTAR a conversa legada (whatsapp_instance_id NULL)
 * em vez de criar uma conversa nova vazia — senão o histórico fica rachado entre as duas.
 * Em empresa multi-número (2+ instâncias ativas) a adoção NÃO dispara: isolamento preservado.
 */

let mockInstances = []
jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn(async () => ({ instances: mockInstances, error: null })),
}))

function createSupabaseConversationMock(seed = {}) {
  const state = { conversas: [...(seed.conversas || [])], operations: [] }

  function makeBuilder(table) {
    const q = {
      table,
      filters: [],
      orders: [],
      limitValue: null,
      mode: 'select',
      payload: null,
      select() { return this },
      eq(field, value) { this.filters.push({ type: 'eq', field, value }); return this },
      neq(field, value) { this.filters.push({ type: 'neq', field, value }); return this },
      in(field, values) { this.filters.push({ type: 'in', field, values }); return this },
      is(field, value) { this.filters.push({ type: 'is', field, value }); return this },
      order(field, opts = {}) { this.orders.push({ field, ascending: opts.ascending !== false }); return this },
      limit(value) { this.limitValue = Number(value); return this },
      insert(payload) { this.mode = 'insert'; this.payload = payload; return this },
      update(payload) { this.mode = 'update'; this.payload = payload; return this },
      delete() { this.mode = 'delete'; return this },
      single() {
        const rows = execute(this)
        if (rows && rows.__error) return Promise.resolve({ data: null, error: rows.__error })
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
      if (f.type === 'neq') return row[f.field] !== f.value
      return row[f.field] === f.value
    })
  }

  function execute(q) {
    const rows = state[q.table] || []
    if (q.mode === 'insert') {
      const payload = { ...q.payload, id: q.payload.id || rows.length + 1, departamento_id: q.payload.departamento_id ?? null }
      rows.push(payload)
      return [payload]
    }
    if (q.mode === 'update') {
      state.operations.push({ table: q.table, mode: q.mode, payload: q.payload, filters: [...q.filters] })
      for (const row of rows) {
        if (matches(row, q.filters)) Object.assign(row, q.payload)
      }
      return rows.filter((row) => matches(row, q.filters))
    }
    if (q.mode === 'delete') {
      state.operations.push({ table: q.table, mode: q.mode, filters: [...q.filters] })
      const deleted = rows.filter((row) => matches(row, q.filters))
      state[q.table] = rows.filter((row) => !matches(row, q.filters))
      return deleted
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

  return { state, from: jest.fn((table) => makeBuilder(table)) }
}

describe('Histórico split por instância — adoção de conversa legada (instância única)', () => {
  beforeEach(() => {
    mockInstances = []
  })

  test('instância única ativa (sem is_default) ADOTA a conversa legada NULL em vez de criar nova', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    mockInstances = [{ id: 8, ativo: true, is_default: false }]
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: null, status_atendimento: 'fechada', departamento_id: null, ultima_atividade: '2026-01-01T00:00:00.000Z' },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 8,
      whatsapp_instance_is_default: false,
    })

    expect(r.created).toBe(false)
    expect(r.conversa.id).toBe(10)
    expect(r.conversa.whatsapp_instance_id).toBe(8)
    // Não criou conversa nova: continua existindo apenas a conversa 10 (agora carimbada).
    expect(supabase.state.conversas).toHaveLength(1)
    expect(supabase.state.conversas[0].whatsapp_instance_id).toBe(8)
  })

  test('empresa multi-número (2+ instâncias ativas) NÃO adota a legada — isolamento preservado', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    mockInstances = [
      { id: 8, ativo: true, is_default: false },
      { id: 9, ativo: true, is_default: false },
    ]
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: null, status_atendimento: 'fechada', departamento_id: null, ultima_atividade: '2026-01-01T00:00:00.000Z' },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 8,
      whatsapp_instance_is_default: false,
    })

    expect(r.created).toBe(true)
    expect(r.conversa.id).not.toBe(10)
    expect(r.conversa.whatsapp_instance_id).toBe(8)
    // A conversa legada NULL permanece intocada (não foi carimbada nem mesclada).
    const legada = supabase.state.conversas.find((c) => c.id === 10)
    expect(legada.whatsapp_instance_id).toBeNull()
    expect(supabase.state.conversas).toHaveLength(2)
  })

  test('instância default continua adotando a legada pelo caminho existente', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    // is_default=true já habilita allowLegacyNullInstance; não depende do serviço de instâncias.
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: null, status_atendimento: 'fechada', departamento_id: null, ultima_atividade: '2026-01-01T00:00:00.000Z' },
      ],
    })

    const r = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 8,
      whatsapp_instance_is_default: true,
    })

    expect(r.created).toBe(false)
    expect(r.conversa.id).toBe(10)
    expect(r.conversa.whatsapp_instance_id).toBe(8)
  })
})
