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
    tags: [], // { id, nome, cor, company_id }
    cliente_tags: [], // { id, company_id, cliente_id, tag_id }
  }
  let tagSeq = 1
  let linkSeq = 1

  function from(table) {
    const filters = []
    let payload = null
    const builder = {
      _table: table,
      select() { return builder },
      insert(data) { payload = data; return builder },
      eq(col, val) { filters.push([col, val]); return builder },
      match(obj) { Object.entries(obj).forEach(([k, v]) => filters.push([k, v])); return builder },
      _matches(row) { return filters.every(([c, v]) => row[c] === v) },
      async maybeSingle() {
        const row = db[table].find((r) => builder._matches(r))
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
        const row = db[table].find((r) => builder._matches(r))
        return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } }
      },
      // insert sem .select() encadeado (cliente_tags): retorna thenable
      then(resolve) {
        if (payload && table === 'cliente_tags') {
          // simula UNIQUE(company_id, cliente_id, tag_id)
          const dup = db.cliente_tags.find(
            (r) => r.company_id === payload.company_id && r.cliente_id === payload.cliente_id && r.tag_id === payload.tag_id
          )
          if (dup) return resolve({ data: null, error: { code: '23505' } })
          const novo = { id: linkSeq++, ...payload }
          db.cliente_tags.push(novo)
          return resolve({ data: novo, error: null })
        }
        return resolve({ data: null, error: null })
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
    expect(getOrCreateCliente).toHaveBeenCalledWith(sb, 7, '5534999991234', expect.objectContaining({ nomeSource: 'import' }))
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
