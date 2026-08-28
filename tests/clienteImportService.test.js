/**
 * Testa a execução da importação isolando a lógica de tags/vínculos.
 * getOrCreateCliente é mockado (já coberto por seus próprios testes); aqui usamos um
 * fake stateful do Supabase apenas para as tabelas `tags` e `cliente_tags`.
 */

jest.mock('../helpers/conversationSync', () => ({
  getOrCreateCliente: jest.fn(),
}))

const { getOrCreateCliente } = require('../helpers/conversationSync')
const { executarImportacao } = require('../services/clienteImportService')

// ---- Fake Supabase stateful (somente tags e cliente_tags) ----
function makeFakeSupabase() {
  const db = {
    tags: [],
    cliente_tags: [],
    clientes: [],
    conversas: [],
  }
  let tagSeq = 1
  let linkSeq = 1

  function from(table) {
    const preds = []
    let payload = null
    let op = 'select'
    const builder = {
      _table: table,
      select() { return builder },
      insert(data) { payload = data; op = 'insert'; return builder },
      update(data) { payload = data; op = 'update'; return builder },
      delete() { op = 'delete'; return builder },
      eq(col, val) { preds.push((row) => row[col] === val); return builder },
      in(col, arr) { const set = new Set(arr); preds.push((row) => set.has(row[col])); return builder },
      match(obj) { Object.entries(obj).forEach(([k, v]) => preds.push((row) => row[k] === v)); return builder },
      _matches(row) { return preds.every((p) => p(row)) },
      _rows() { return Array.isArray(db[table]) ? db[table] : [] },
      async maybeSingle() {
        const row = builder._rows().find((r) => builder._matches(r))
        return { data: row ? { ...row } : null, error: null }
      },
      async single() {
        // usado após insert
        if (payload) {
          if (table === 'tags') {
            const novo = { id: tagSeq++, cor: null, ...payload }
            db.tags.push(novo)
            return { data: { id: novo.id }, error: null }
          }
        }
        const row = builder._rows().find((r) => builder._matches(r))
        return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } }
      },
      then(resolve) {
        if (op === 'insert' && payload && table === 'cliente_tags') {
          const dup = db.cliente_tags.find(
            (r) => r.company_id === payload.company_id && r.cliente_id === payload.cliente_id && r.tag_id === payload.tag_id
          )
          if (dup) return resolve({ data: null, error: { code: '23505' } })
          const novo = { id: linkSeq++, ...payload }
          db.cliente_tags.push(novo)
          return resolve({ data: novo, error: null })
        }
        if (op === 'update') {
          const rows = builder._rows()
          db[table] = rows.map((r) => (builder._matches(r) ? { ...r, ...payload } : r))
          return resolve({ data: null, error: null })
        }
        if (op === 'delete') {
          const rows = builder._rows()
          const antes = rows.length
          db[table] = rows.filter((r) => !builder._matches(r))
          return resolve({ data: null, error: null, count: antes - db[table].length })
        }
        return resolve({ data: builder._rows().filter((r) => builder._matches(r)).map((r) => ({ ...r })), error: null })
      },
    }
    return builder
  }

  return { from, __db: db }
}

function plano(entries) {
  return {
    entries,
    ignored: [],
    conflicts: [],
    stats: { totalLinhas: entries.length, validas: entries.length },
  }
}

beforeEach(() => {
  getOrCreateCliente.mockReset()
})

describe('clienteImportService — execução', () => {
  it('cria cliente novo, cria tag nova e vincula', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: true })
    const sb = makeFakeSupabase()

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['6º Ano'] },
    ]))

    expect(res.resumo.clientesImportados).toBe(1)
    expect(res.resumo.clientesJaExistentes).toBe(0)
    expect(res.resumo.tagsCriadas).toBe(1)
    expect(res.resumo.tagsVinculadas).toBe(1)
    expect(sb.__db.tags[0]).toMatchObject({ nome: '6º Ano', company_id: 7 })
    expect(sb.__db.cliente_tags[0]).toMatchObject({ company_id: 7, cliente_id: 10, tag_id: 1 })
  })

  it('cliente já existente é contado separadamente e não vira novo', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 99, created: false })
    const sb = makeFakeSupabase()

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: [] },
    ]))

    expect(res.resumo.clientesImportados).toBe(0)
    expect(res.resumo.clientesJaExistentes).toBe(1)
  })

  it('reutiliza tag existente (não cria de novo)', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: true })
    const sb = makeFakeSupabase()
    sb.__db.tags.push({ id: 1, nome: '6º Ano', cor: null, company_id: 7 })

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['6º Ano'] },
    ]))

    expect(res.resumo.tagsCriadas).toBe(0)
    expect(res.resumo.tagsVinculadas).toBe(1)
    expect(sb.__db.tags).toHaveLength(1)
  })

  it('não recontabiliza vínculo de tag já existente', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: false })
    const sb = makeFakeSupabase()
    sb.__db.tags.push({ id: 1, nome: '6º Ano', cor: null, company_id: 7 })
    sb.__db.cliente_tags.push({ id: 1, company_id: 7, cliente_id: 10, tag_id: 1 })

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['6º Ano'] },
    ]))

    expect(res.resumo.tagsVinculadas).toBe(0)
    expect(sb.__db.cliente_tags).toHaveLength(1)
  })

  it('planilha manda: aluno que virou 8º perde a etiqueta antiga de 5º (não fica duas)', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: false })
    const sb = makeFakeSupabase()
    sb.__db.tags.push({ id: 1, nome: '5º Ano', cor: null, company_id: 7 })
    sb.__db.tags.push({ id: 2, nome: '8º Ano', cor: null, company_id: 7 })
    sb.__db.cliente_tags.push({ id: 1, company_id: 7, cliente_id: 10, tag_id: 1 }) // 5º antigo

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['8º Ano'] },
    ]))

    expect(res.resumo.tagsRemovidas).toBe(1)
    expect(res.resumo.tagsVinculadas).toBe(1)
    // cliente fica SÓ com o 8º (tag_id 2)
    expect(sb.__db.cliente_tags.map((r) => r.tag_id)).toEqual([2])
  })

  it('linha sem etiqueta NÃO apaga as etiquetas existentes (guarda contra planilha incompleta)', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: false })
    const sb = makeFakeSupabase()
    sb.__db.tags.push({ id: 1, nome: '5º Ano', cor: null, company_id: 7 })
    sb.__db.cliente_tags.push({ id: 1, company_id: 7, cliente_id: 10, tag_id: 1 })

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: [] },
    ]))

    expect(res.resumo.tagsRemovidas).toBe(0)
    expect(sb.__db.cliente_tags).toHaveLength(1)
  })

  it('preserva outras etiquetas do cliente que também estão na planilha (só tira as ausentes)', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: false })
    const sb = makeFakeSupabase()
    sb.__db.tags.push({ id: 1, nome: '5º Ano', cor: null, company_id: 7 })
    sb.__db.tags.push({ id: 2, nome: '8º Ano', cor: null, company_id: 7 })
    sb.__db.tags.push({ id: 3, nome: 'Bolsista', cor: null, company_id: 7 })
    sb.__db.cliente_tags.push({ id: 1, company_id: 7, cliente_id: 10, tag_id: 1 }) // 5º (sai)
    sb.__db.cliente_tags.push({ id: 2, company_id: 7, cliente_id: 10, tag_id: 3 }) // Bolsista (fica)

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['8º Ano', 'Bolsista'] },
    ]))

    expect(res.resumo.tagsRemovidas).toBe(1) // só o 5º
    expect(sb.__db.cliente_tags.map((r) => r.tag_id).sort()).toEqual([2, 3])
  })

  it('mesma tag em vários contatos é criada uma única vez (cache) e vinculada a todos', async () => {
    getOrCreateCliente
      .mockResolvedValueOnce({ cliente_id: 10, created: true })
      .mockResolvedValueOnce({ cliente_id: 11, created: true })
    const sb = makeFakeSupabase()

    const res = await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['6º Ano'] },
      { telefone: '5534988887777', nome: 'Maria', tags: ['6º Ano'] },
    ]))

    expect(res.resumo.tagsCriadas).toBe(1)
    expect(res.resumo.tagsVinculadas).toBe(2)
    expect(sb.__db.tags).toHaveLength(1)
    expect(sb.__db.cliente_tags).toHaveLength(2)
  })

  it('isolamento por empresa: usa SEMPRE o company_id passado (nunca do entry)', async () => {
    getOrCreateCliente.mockResolvedValue({ cliente_id: 10, created: true })
    const sb = makeFakeSupabase()

    await executarImportacao(sb, 7, plano([
      { telefone: '5534999991234', nome: 'João', tags: ['6º Ano'], company_id: 999 },
    ]))

    // getOrCreateCliente recebeu o cid da empresa (7), não 999
    expect(getOrCreateCliente).toHaveBeenCalledWith(sb, 7, '5534999991234', expect.objectContaining({ nomeSource: 'import_planilha' }))
    expect(sb.__db.tags[0].company_id).toBe(7)
    expect(sb.__db.cliente_tags[0].company_id).toBe(7)
  })

  it('falha isolada em um contato não interrompe o lote', async () => {
    getOrCreateCliente
      .mockResolvedValueOnce({ cliente_id: null, created: false }) // falha
      .mockResolvedValueOnce({ cliente_id: 11, created: true }) // sucesso
    const sb = makeFakeSupabase()

    const res = await executarImportacao(sb, 7, plano([
      { telefone: 'invalido', nome: 'X', tags: [] },
      { telefone: '5534988887777', nome: 'Maria', tags: [] },
    ]))

    expect(res.resumo.clientesImportados).toBe(1)
    expect(res.resumo.falhas).toBe(1)
    expect(res.falhas[0].nome).toBe('X')
  })

  it('rejeita company_id inválido', async () => {
    await expect(executarImportacao(makeFakeSupabase(), 0, plano([]))).rejects.toThrow('company_id inválido')
  })
})
