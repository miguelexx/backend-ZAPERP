/**
 * Guarda do BACKFILL de `conversas.tem_mensagem` (doc 41, etapa 5 — 12/11/2026).
 *
 * A coluna existir não basta: enquanto o passo A2 da migration não zera, há conversas COM
 * mensagem e flag `false`, e o `count(*)` novo sairia MENOR que o real em silêncio (a causa
 * provável dos chips zerados no deploy de 11/11). `temMensagemPronta()` sonda isso 1× por
 * processo com `mensagens!inner` + `tem_mensagem = false` + `limit 1`.
 *
 * O que este teste trava (cada caso conferido a falhar com a mutação — não sondar; não
 * memorizar; não respeitar o recheck):
 *   1. backfill pendente → caminho ANTIGO (varredura com range), aviso 1×, e a sonda não
 *      repete a cada chamada (só depois de CONVERSAS_TEM_MENSAGEM_RECHECK_MS);
 *   2. backfill concluído → caminho novo (count head com `tem_mensagem` no .or), sonda 1× só;
 *   3. sonda com erro transitório → caminho antigo nesta chamada e sonda de novo na próxima;
 *   4. sonda com 42703 → desliga a coluna como antes.
 */

// Prefixo `mock`: o Jest só permite a fábrica de `jest.mock()` referenciar variáveis assim.
const mockEstado = { sonda: [], sondaCalls: 0, countCalls: 0, rangeCalls: 0 }

jest.mock('../config/supabase', () => {
  const METODOS = ['select', 'eq', 'neq', 'or', 'in', 'not', 'is', 'gte', 'lte', 'order', 'limit', 'range']
  const responder = (tabela, chamadas) => {
    if (tabela !== 'conversas') return { data: [], count: 0, error: null }
    const select = chamadas.find((c) => c.metodo === 'select')
    if (select && String(select.args[0]).includes('mensagens!inner')) {
      mockEstado.sondaCalls++
      const r = mockEstado.sonda.length > 1 ? mockEstado.sonda.shift() : mockEstado.sonda[0]
      return r
    }
    if (select && select.args[1] && select.args[1].head === true) {
      mockEstado.countCalls++
      return { data: null, count: 77, error: null }
    }
    if (chamadas.some((c) => c.metodo === 'range')) mockEstado.rangeCalls++
    return { data: [], count: null, error: null }
  }
  const fabricarBuilder = (tabela) => {
    const chamadas = []
    const builder = {}
    for (const m of METODOS) builder[m] = (...args) => { chamadas.push({ metodo: m, args }); return builder }
    builder.maybeSingle = () => ({ then: (resolve) => resolve({ data: null, error: null }) })
    builder.single = builder.maybeSingle
    builder.then = (resolve, reject) => Promise.resolve(responder(tabela, chamadas)).then(resolve, reject)
    return builder
  }
  return { from: (tabela) => fabricarBuilder(tabela), rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }) }
})

const coluna = require('../helpers/conversasTemMensagemColumn')
const { countConversasWithFilter } = require('../services/chatListCountsService')

const PENDENTE = { data: [{ id: 1 }], count: null, error: null }
const CONCLUIDO = { data: [], count: null, error: null }
const ctxAdmin = {
  company_id: 1, user_id: 7, isAdmin: true, isAtendente: false, departamento_ids: [],
  filtroAtendenteInformado: null, conversaIdsTransferidas: [], conversaIdsParticipanteAtivo: [],
  grupoIdsPermitidosPorDepartamento: [], grupoIdsSemDepartamento: [], grupoIdsFixadosNaMinhaFila: [],
  conversaIdsFilter: null, forceEmptyConversas: false, instanciasPermitidasAtendente: null,
}
let warnSpy
beforeEach(() => {
  mockEstado.sonda = [CONCLUIDO]
  mockEstado.sondaCalls = 0
  mockEstado.countCalls = 0
  mockEstado.rangeCalls = 0
  coluna._test.religar()
  delete process.env.CONVERSAS_TEM_MENSAGEM_RECHECK_MS
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warnSpy.mockRestore())

const contarAbertas = () => countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })

test('1) backfill pendente: caminho antigo, aviso 1x, sonda não repete antes do recheck', async () => {
  mockEstado.sonda = [PENDENTE]
  process.env.CONVERSAS_TEM_MENSAGEM_RECHECK_MS = '60000'
  await contarAbertas()
  await contarAbertas()
  await contarAbertas()
  expect(mockEstado.countCalls).toBe(0)
  expect(mockEstado.rangeCalls).toBe(3)
  expect(mockEstado.sondaCalls).toBe(1)
  const avisos = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('BACKFILL'))
  expect(avisos).toHaveLength(1)
})

test('2) backfill concluído: caminho novo e a sonda roda só uma vez por processo', async () => {
  const a = await contarAbertas()
  const b = await contarAbertas()
  expect(a).toBe(77)
  expect(b).toBe(77)
  expect(mockEstado.countCalls).toBe(2)
  expect(mockEstado.rangeCalls).toBe(0)
  expect(mockEstado.sondaCalls).toBe(1)
})

test('2b) chamadas concorrentes partilham UMA sonda', async () => {
  await Promise.all([contarAbertas(), contarAbertas(), contarAbertas()])
  expect(mockEstado.sondaCalls).toBe(1)
  expect(mockEstado.countCalls).toBe(3)
})

test('3) erro transitório na sonda: caminho antigo agora, sonda de novo na próxima', async () => {
  mockEstado.sonda = [{ data: null, count: null, error: { message: 'timeout' } }, CONCLUIDO]
  await contarAbertas()
  expect(mockEstado.rangeCalls).toBe(1)
  expect(mockEstado.countCalls).toBe(0)
  await contarAbertas()
  expect(mockEstado.sondaCalls).toBe(2)
  expect(mockEstado.countCalls).toBe(1)
})

test('4) sonda com 42703: coluna desligada no processo, como antes', async () => {
  mockEstado.sonda = [{ data: null, count: null, error: { code: '42703', message: 'column conversas.tem_mensagem does not exist' } }]
  await contarAbertas()
  await contarAbertas()
  expect(coluna.temMensagemDisponivel()).toBe(false)
  expect(mockEstado.sondaCalls).toBe(1)
  expect(mockEstado.rangeCalls).toBe(2)
})
