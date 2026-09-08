/**
 * Cadastro de contato: o cliente NOVO nasce já na identidade WhatsApp canônica.
 * Celular BR legado sem o 9 (34 9826-5514 → 553498265514) é gravado com o 9 (5534998265514),
 * para a conversa abrir/enviar no número REAL do WhatsApp. Fixo e existentes não são afetados.
 * Ver conversationSync.canonicalBrWhatsappForStorage + getOrCreateCliente.
 */

const supabaseMock = { from: null }
jest.mock('../config/supabase', () => ({ from: (...a) => supabaseMock.from(...a) }))

const { getOrCreateCliente } = require('../helpers/conversationSync')

function makeFakeSupabase(initial = {}) {
  const db = {}
  for (const [k, v] of Object.entries(initial)) db[k] = v.map((r) => ({ ...r }))
  let seq = 1000
  function from(table) {
    if (!Array.isArray(db[table])) db[table] = []
    const preds = []
    let op = 'select'
    let payload = null
    let conflictCols = null
    let ignoreDuplicates = false
    const builder = {
      select() { return builder },
      insert(d) { op = 'insert'; payload = d; return builder },
      upsert(d, opts) {
        op = 'upsert'; payload = d
        conflictCols = opts && opts.onConflict ? String(opts.onConflict).split(',') : null
        ignoreDuplicates = !!(opts && opts.ignoreDuplicates)
        return builder
      },
      update(d) { op = 'update'; payload = d; return builder },
      delete() { op = 'delete'; return builder },
      eq(col, val) { preds.push((r) => r[col] === val); return builder },
      neq(col, val) { preds.push((r) => r[col] !== val); return builder },
      in(col, arr) { const s = new Set(arr); preds.push((r) => s.has(r[col])); return builder },
      like(col, pattern) {
        const re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$')
        preds.push((r) => typeof r[col] === 'string' && re.test(r[col]))
        return builder
      },
      not() { return builder },
      is(col, val) { if (val === null) preds.push((r) => r[col] == null); return builder },
      order() { return builder },
      limit() { return builder },
      _rows() { return db[table] },
      _match(r) { return preds.every((p) => p(r)) },
      _selected() { return db[table].filter((r) => builder._match(r)) },
      async maybeSingle() { const row = builder._selected()[0]; return { data: row ? { ...row } : null, error: null } },
      async single() {
        if (op === 'insert' && payload) { const novo = { id: seq++, ...payload }; db[table].push(novo); return { data: { ...novo }, error: null } }
        const row = builder._selected()[0]
        return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } }
      },
      then(resolve) {
        if (op === 'select') return resolve({ data: builder._selected().map((r) => ({ ...r })), error: null })
        if (op === 'insert') { const novo = { id: seq++, ...payload }; db[table].push(novo); return resolve({ data: { ...novo }, error: null }) }
        if (op === 'upsert') {
          const exists = conflictCols ? db[table].find((r) => conflictCols.every((c) => r[c] === payload[c])) : null
          if (exists && ignoreDuplicates) return resolve({ data: null, error: null })
          if (exists) { Object.assign(exists, payload); return resolve({ data: { ...exists }, error: null }) }
          const novo = { id: seq++, ...payload }; db[table].push(novo)
          return resolve({ data: { ...novo }, error: null })
        }
        if (op === 'update') { for (const r of db[table]) if (builder._match(r)) Object.assign(r, payload); return resolve({ data: null, error: null }) }
        return resolve({ data: null, error: null })
      },
    }
    return builder
  }
  return { from, _db: db }
}

const COMPANY = 7

describe('Cadastro de contato — identidade WhatsApp canônica no INSERT', () => {
  test('celular legado 34 9826-5514 (553498265514) nasce com o 9 → 5534998265514', async () => {
    const sb = makeFakeSupabase({ clientes: [] })
    const res = await getOrCreateCliente(sb, COMPANY, '553498265514', { nome: 'Murilo', allowNonBR: true })
    expect(res.cliente_id).toBeTruthy()
    expect(res.created).toBe(true)
    expect(sb._db.clientes).toHaveLength(1)
    expect(sb._db.clientes[0].telefone).toBe('5534998265514')
  })

  test('fixo 34 3232-1234 (553432321234) permanece SEM o 9', async () => {
    const sb = makeFakeSupabase({ clientes: [] })
    await getOrCreateCliente(sb, COMPANY, '553432321234', { nome: 'Loja', allowNonBR: true })
    expect(sb._db.clientes[0].telefone).toBe('553432321234')
  })

  test('cliente já salvo sem o 9 é REAPROVEITADO (não duplica) ao cadastrar o mesmo número', async () => {
    const sb = makeFakeSupabase({ clientes: [{ id: 55, company_id: COMPANY, telefone: '553498265514', nome: 'Antigo' }] })
    const res = await getOrCreateCliente(sb, COMPANY, '553498265514', { nome: 'Murilo', allowNonBR: true })
    expect(res.cliente_id).toBe(55)
    expect(res.created).toBe(false)
    expect(sb._db.clientes).toHaveLength(1)
  })

  test('número internacional (allowNonBR) não ganha 55 nem 9', async () => {
    const sb = makeFakeSupabase({ clientes: [] })
    // 12 dígitos internacionais (não BR) — via getCanonicalPhoneAnyIntl no fallback allowNonBR
    await getOrCreateCliente(sb, COMPANY, '447911123456', { nome: 'UK', allowNonBR: true })
    expect(sb._db.clientes).toHaveLength(1)
    expect(sb._db.clientes[0].telefone).toBe('447911123456')
  })
})
