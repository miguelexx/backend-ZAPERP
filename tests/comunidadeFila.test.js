/**
 * Fila de Comunidades — cancelarOperacoesDoAlvo (usado ao apagar a comunidade).
 * Supabase mockado com fila de resultados; sem rede nem DB real.
 */

describe('comunidadeFilaService.cancelarOperacoesDoAlvo', () => {
  let emitMock

  function makeSupabase(results) {
    const calls = []
    const queue = [...results]
    function builder(table) {
      const ctx = { table, ops: [] }
      const b = {}
      const rec = (name) => (...args) => { ctx.ops.push([name, ...args]); return b }
      for (const m of ['select', 'update', 'insert', 'eq', 'in', 'order', 'limit', 'gte', 'single', 'maybeSingle']) {
        b[m] = rec(m)
      }
      b.then = (resolve, reject) => {
        calls.push(ctx)
        return Promise.resolve(queue.length ? queue.shift() : { data: null, error: null }).then(resolve, reject)
      }
      return b
    }
    return { mock: { from: (t) => builder(t) }, calls }
  }

  function load(supabaseMock) {
    jest.resetModules()
    emitMock = jest.fn()
    jest.doMock('../config/supabase', () => supabaseMock)
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../services/comunidade/comunidadeSocketService', () => ({
      emitComunidade: emitMock,
      EVENTS: { OPERACAO_ATUALIZADA: 'comunidade_operacao_atualizada' },
    }))
    return require('../services/comunidade/comunidadeFilaService')
  }

  afterEach(() => jest.resetModules())

  const CID = '120363426760868023@g.us'

  test('cancela operações ativas + itens pendentes e emite socket por operação', async () => {
    const { mock, calls } = makeSupabase([
      { data: [{ id: 'op1' }, { id: 'op2' }], error: null }, // select operações ativas
      { data: null, error: null }, // update itens → cancelada
      { data: [{ id: 'op1', status: 'cancelada' }, { id: 'op2', status: 'cancelada' }], error: null }, // update ops
    ])
    const fila = load(mock)
    const n = await fila.cancelarOperacoesDoAlvo({ io: {}, companyId: 1, comunidadeId: CID })
    expect(n).toBe(2)

    expect(calls).toHaveLength(3)
    expect(calls[0].table).toBe('comunidade_operacoes')
    expect(calls[0].ops).toContainEqual(['in', 'status', ['em_execucao', 'pausada']])
    expect(calls[0].ops).toContainEqual(['eq', 'comunidade_id', CID])

    expect(calls[1].table).toBe('comunidade_fila_itens')
    expect(calls[1].ops[0][0]).toBe('update')
    expect(calls[1].ops[0][1].status).toBe('cancelada')
    expect(calls[1].ops).toContainEqual(['in', 'operacao_id', ['op1', 'op2']])
    expect(calls[1].ops).toContainEqual(['in', 'status', ['pendente', 'reservada', 'enviando']])

    expect(calls[2].table).toBe('comunidade_operacoes')
    expect(calls[2].ops[0][1].status).toBe('cancelada')

    expect(emitMock).toHaveBeenCalledTimes(2)
  })

  test('sem operações ativas → 0 e nenhum update', async () => {
    const { mock, calls } = makeSupabase([{ data: [], error: null }])
    const fila = load(mock)
    const n = await fila.cancelarOperacoesDoAlvo({ io: {}, companyId: 1, comunidadeId: CID })
    expect(n).toBe(0)
    expect(calls).toHaveLength(1)
    expect(emitMock).not.toHaveBeenCalled()
  })

  test('cid vazio ou company inválida → 0 sem tocar o banco', async () => {
    const { mock, calls } = makeSupabase([])
    const fila = load(mock)
    expect(await fila.cancelarOperacoesDoAlvo({ companyId: 1, comunidadeId: '' })).toBe(0)
    expect(await fila.cancelarOperacoesDoAlvo({ companyId: NaN, comunidadeId: CID })).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
