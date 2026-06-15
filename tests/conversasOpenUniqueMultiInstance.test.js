const fs = require('fs')
const path = require('path')

function createSupabaseConversationMock(seed = {}) {
  const state = {
    conversas: [...(seed.conversas || [])],
    insertErrors: [...(seed.insertErrors || [])],
    insertErrorRows: [...(seed.insertErrorRows || [])],
  }

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
      in(field, values) { this.filters.push({ type: 'in', field, values }); return this },
      is(field, value) { this.filters.push({ type: 'is', field, value }); return this },
      order(field, opts = {}) { this.orders.push({ field, ascending: opts.ascending !== false }); return this },
      limit(value) { this.limitValue = Number(value); return this },
      insert(payload) { this.mode = 'insert'; this.payload = payload; return this },
      update(payload) { this.mode = 'update'; this.payload = payload; return this },
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
      return row[f.field] === f.value
    })
  }

  function execute(q) {
    const rows = state[q.table] || []
    if (q.mode === 'insert') {
      if (q.table === 'conversas' && state.insertErrors.length > 0) {
        const error = state.insertErrors.shift()
        const raceRow = state.insertErrorRows.shift()
        if (raceRow) rows.push({ ...raceRow })
        return { __error: error }
      }
      const payload = { ...q.payload, id: q.payload.id || rows.length + 1, departamento_id: q.payload.departamento_id ?? null }
      rows.push(payload)
      return [payload]
    }
    if (q.mode === 'update') {
      for (const row of rows) {
        if (matches(row, q.filters)) Object.assign(row, q.payload)
      }
      return rows.filter((row) => matches(row, q.filters))
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

describe('Conversas open unique multi-instancia', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('migration substitui idx_conversas_company_telefone_open_unique por indices com instancia', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260615120000_conversas_open_unique_multi_instance.sql'),
      'utf8'
    )
    const precheck = fs.readFileSync(
      path.join(__dirname, '../supabase/prechecks/20260615120000_conversas_open_unique_multi_instance_precheck.sql'),
      'utf8'
    )
    const production = fs.readFileSync(
      path.join(__dirname, '../supabase/production/20260615120000_conversas_open_unique_multi_instance_concurrently.sql'),
      'utf8'
    )

    expect(migration).toContain('idx_conversas_company_instance_telefone_open_unique')
    expect(migration).toContain('on public.conversas (company_id, whatsapp_instance_id, telefone)')
    expect(migration).toContain("status_atendimento in ('aberta', 'em_atendimento')")
    expect(migration).toContain('idx_conversas_company_telefone_open_legacy_null_unique')
    expect(migration).toContain('where whatsapp_instance_id is null')
    expect(migration).toContain('drop index if exists public.idx_conversas_company_telefone_open_unique')
    expect(precheck).toContain('DUPLICIDADE_OPEN_INSTANCE_TELEFONE')
    expect(precheck).toContain('DUPLICIDADE_OPEN_LEGADO_TELEFONE_NULL_INSTANCE')
    expect(precheck).toContain('INFORMATIVO_TELEFONE_ABERTO_EM_MULTIPLAS_INSTANCIAS')
    expect(production).toContain('create unique index concurrently')
    expect(production).toContain('drop index concurrently if exists public.idx_conversas_company_telefone_open_unique')
  })

  test('mesmo telefone aberto em instancias 1 e 8 permanecem separadas no findOrCreate', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 1, status_atendimento: 'aberta', departamento_id: null },
        { id: 20, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 8, status_atendimento: 'aberta', departamento_id: null },
      ],
    })

    const r1 = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 1,
      whatsapp_instance_is_default: false,
    })
    const r8 = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 8,
      whatsapp_instance_is_default: false,
    })

    expect(r1.conversa.id).toBe(10)
    expect(r8.conversa.id).toBe(20)
    expect(r1.created).toBe(false)
    expect(r8.created).toBe(false)
  })

  test('violacao do indice open unique rebusca conversa da instancia 8 sem cair na instancia 1', async () => {
    const { findOrCreateConversation } = require('../helpers/conversationSync')
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 1, status_atendimento: 'aberta', departamento_id: null },
      ],
      insertErrors: [
        {
          code: '23505',
          message: 'duplicate key value violates unique constraint "idx_conversas_company_telefone_open_unique"',
        },
      ],
      insertErrorRows: [
        { id: 20, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 8, status_atendimento: 'aberta', departamento_id: null },
      ],
    })

    const result = await findOrCreateConversation(supabase, {
      company_id: 1,
      phone: '5534999999999',
      whatsapp_instance_id: 8,
      whatsapp_instance_is_default: false,
    })

    expect(result.created).toBe(false)
    expect(result.conversa.id).toBe(20)
    expect(result.conversa.whatsapp_instance_id).toBe(8)
  })
})
