/**
 * Deduplicação de clientes por identidade WhatsApp (mesmo número com/sem o 9º dígito).
 *
 * Cobre:
 * 1) Prevenção: getOrCreateCliente com strictAgendaImport ATUALIZA o contato já salvo no
 *    outro formato de telefone em vez de criar um segundo cliente.
 * 2) Limpeza: dedupeClientesForCompany em dry-run (não grava) e em apply (reaponta TODAS as
 *    tabelas com FK cliente_id antes de excluir, preserva campos e escolhe o canônico certo).
 * 3) Segurança: números realmente diferentes (fixo, outro DDD) NÃO são fundidos.
 */

const holder = {}
jest.mock('../config/supabase', () => ({
  from: (table) => holder.sb.from(table),
}))

const { getOrCreateCliente } = require('../helpers/conversationSync')
const { dedupeClientesForCompany } = require('../services/clienteDedupeService')

// ---------------------------------------------------------------------------
// Fake Supabase stateful e genérico (suporta as cadeias usadas pelos serviços).
// ---------------------------------------------------------------------------
function makeFakeSupabase(initial = {}) {
  const db = {}
  for (const [k, v] of Object.entries(initial)) db[k] = v.map((r) => ({ ...r }))
  let seq = 1000

  function from(table) {
    if (!Array.isArray(db[table])) db[table] = []
    const preds = []
    let op = 'select'
    let payload = null
    let head = false
    let wantCount = false
    let conflictCols = null
    let ignoreDuplicates = false

    const builder = {
      select(_cols, opts) {
        if (opts && opts.count) wantCount = true
        if (opts && opts.head) head = true
        return builder
      },
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
      not(col, operator, val) {
        if (operator === 'like') {
          const prefix = String(val).replace(/%$/, '')
          preds.push((r) => !(typeof r[col] === 'string' && r[col].startsWith(prefix)))
        } else if (operator === 'is') {
          preds.push((r) => !(r[col] == null))
        } else {
          preds.push((r) => r[col] !== val)
        }
        return builder
      },
      is(col, val) { if (val === null) preds.push((r) => r[col] == null); return builder },
      order() { return builder },
      limit() { return builder },
      _rows() { return db[table] },
      _match(r) { return preds.every((p) => p(r)) },
      _selected() { return db[table].filter((r) => builder._match(r)) },
      async maybeSingle() {
        const row = builder._selected()[0]
        return { data: row ? { ...row } : null, error: null }
      },
      async single() {
        if (op === 'insert' && payload) {
          const novo = { id: seq++, ...payload }
          db[table].push(novo)
          return { data: { ...novo }, error: null }
        }
        const row = builder._selected()[0]
        return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } }
      },
      then(resolve) {
        if (op === 'select') {
          const sel = builder._selected()
          if (head && wantCount) return resolve({ data: null, count: sel.length, error: null })
          return resolve({ data: sel.map((r) => ({ ...r })), error: null })
        }
        if (op === 'update') {
          let n = 0
          for (const r of db[table]) if (builder._match(r)) { Object.assign(r, payload); n++ }
          return resolve({ data: null, error: null, count: n })
        }
        if (op === 'delete') {
          const keep = db[table].filter((r) => !builder._match(r))
          const removed = db[table].length - keep.length
          db[table] = keep
          return resolve({ data: null, error: null, count: removed })
        }
        if (op === 'insert') {
          const novo = { id: seq++, ...payload }
          db[table].push(novo)
          return resolve({ data: { ...novo }, error: null })
        }
        if (op === 'upsert') {
          const exists = conflictCols
            ? db[table].find((r) => conflictCols.every((c) => r[c] === payload[c]))
            : null
          if (exists && ignoreDuplicates) return resolve({ data: null, error: null })
          if (exists) { Object.assign(exists, payload); return resolve({ data: { ...exists }, error: null }) }
          const novo = { id: seq++, ...payload }
          db[table].push(novo)
          return resolve({ data: { ...novo }, error: null })
        }
        return resolve({ data: null, error: null })
      },
    }
    return builder
  }

  return { from, _db: db }
}

const COMPANY = 7

describe('Prevenção — importação da agenda não duplica contato já salvo no outro formato', () => {
  test('strictAgendaImport ATUALIZA o cliente existente (12 díg) ao importar o mesmo número (13 díg)', async () => {
    holder.sb = makeFakeSupabase({
      clientes: [{ id: 101, company_id: COMPANY, telefone: '553484165218', nome: null }],
    })

    const res = await getOrCreateCliente(holder.sb, COMPANY, '5534984165218', {
      nome: 'Alex Construtora Maranata',
      nomeSource: 'syncUltramsg',
      allowNonBR: true,
      strictAgendaImport: true,
    })

    expect(res.cliente_id).toBe(101)
    expect(res.created).toBe(false)
    // Não criou segundo cliente
    expect(holder.sb._db.clientes).toHaveLength(1)
    expect(holder.sb._db.clientes[0].nome).toBe('Alex Construtora Maranata')
  })
})

describe('dedupeClientesForCompany — dry-run não grava nada', () => {
  test('detecta o grupo e conta referências sem excluir', async () => {
    holder.sb = makeFakeSupabase({
      clientes: [
        { id: 1, company_id: COMPANY, telefone: '553484165218', nome: null },
        { id: 2, company_id: COMPANY, telefone: '5534984165218', nome: 'Alex' },
      ],
      conversas: [{ id: 50, company_id: COMPANY, cliente_id: 1 }],
      crm_leads: [{ id: 900, company_id: COMPANY, cliente_id: 2 }],
    })

    const rep = await dedupeClientesForCompany(COMPANY, { apply: false })

    expect(rep.ok).toBe(true)
    expect(rep.grupos).toBe(1)
    expect(rep.duplicados).toBe(1)
    expect(rep.clientesRemovidos).toBe(0)
    // Canônico = o que tem conversa (id 1)
    expect(rep.canonicals[0].canonicalId).toBe(1)
    // Referência do duplicado (id 2) no crm_leads foi contabilizada
    const crmAction = rep.canonicals[0].referencias.find((a) => a.table === 'crm_leads')
    expect(crmAction).toEqual({ table: 'crm_leads', rows: 1 })
    // Nada foi apagado
    expect(holder.sb._db.clientes).toHaveLength(2)
    expect(holder.sb._db.crm_leads[0].cliente_id).toBe(2)
  })
})

describe('dedupeClientesForCompany — apply reaponta FKs, preserva campos e exclui', () => {
  test('CRM/opt-in/nome-vinculado migram para o canônico e o duplicado some (sem perda de dados)', async () => {
    holder.sb = makeFakeSupabase({
      clientes: [
        { id: 1, company_id: COMPANY, telefone: '553484165218', nome: null, foto_perfil: null },
        { id: 2, company_id: COMPANY, telefone: '5534984165218', nome: 'Alex', foto_perfil: 'https://cdn/x.jpg' },
      ],
      conversas: [{ id: 50, company_id: COMPANY, cliente_id: 1 }],
      crm_leads: [{ id: 900, company_id: COMPANY, cliente_id: 2 }],
      contato_opt_in: [{ id: 800, company_id: COMPANY, cliente_id: 2 }],
      cliente_nomes_vinculados: [{ id: 700, company_id: COMPANY, cliente_id: 2 }],
    })

    const rep = await dedupeClientesForCompany(COMPANY, { apply: true })

    expect(rep.clientesRemovidos).toBe(1)
    expect(rep.errors).toHaveLength(0)
    // Só o canônico (id 1) permanece
    expect(holder.sb._db.clientes.map((c) => c.id)).toEqual([1])
    // Campos vazios do canônico preenchidos a partir do duplicado
    expect(holder.sb._db.clientes[0].nome).toBe('Alex')
    expect(holder.sb._db.clientes[0].foto_perfil).toBe('https://cdn/x.jpg')
    // TODAS as referências repontadas para o canônico (nada perdido por CASCADE/SET NULL)
    expect(holder.sb._db.crm_leads[0].cliente_id).toBe(1)
    expect(holder.sb._db.contato_opt_in[0].cliente_id).toBe(1)
    expect(holder.sb._db.cliente_nomes_vinculados[0].cliente_id).toBe(1)
  })
})

describe('dedupeClientesForCompany — segurança: não funde números diferentes', () => {
  test('mesmos 8 finais em DDDs diferentes não são agrupados', async () => {
    holder.sb = makeFakeSupabase({
      clientes: [
        { id: 1, company_id: COMPANY, telefone: '5511987654321', nome: 'A' },
        { id: 2, company_id: COMPANY, telefone: '5521987654321', nome: 'B' },
      ],
    })
    const rep = await dedupeClientesForCompany(COMPANY, { apply: true })
    expect(rep.grupos).toBe(0)
    expect(rep.clientesRemovidos).toBe(0)
    expect(holder.sb._db.clientes).toHaveLength(2)
  })

  test('fixo e celular que só diferem pelo 9º dígito não são fundidos', async () => {
    holder.sb = makeFakeSupabase({
      clientes: [
        { id: 1, company_id: COMPANY, telefone: '553433334444', nome: 'Fixo' },   // fixo (local 3)
        { id: 2, company_id: COMPANY, telefone: '5534933334444', nome: 'Cel?' },  // sem o 9 → local 3 (não é celular)
      ],
    })
    const rep = await dedupeClientesForCompany(COMPANY, { apply: true })
    expect(rep.grupos).toBe(0)
    expect(holder.sb._db.clientes).toHaveLength(2)
  })
})
