/**
 * Smoke test dos handlers de LEITURA modularizados (controllers/chat/*).
 *
 * Objetivo: garantir que a fachada chatController reexporta os handlers e que cada um
 * EXECUTA de ponta a ponta com o Supabase mockado — sem ReferenceError por import
 * faltante após a modularização (listController/historyController/shared).
 *
 * As rotas reais só testam 401 (sem token), então o corpo dos handlers nunca rodava nos
 * testes. Este guard cobre exatamente essa lacuna: se um símbolo deixar de ser importado
 * em um dos módulos novos, o handler loga "X is not defined" e este teste falha.
 */
const chatController = require('../controllers/chatController')

function makeRes() {
  const res = {}
  res.statusCode = 200
  res.json = jest.fn(() => res)
  res.status = jest.fn((c) => { res.statusCode = c; return res })
  res.setHeader = jest.fn(() => res)
  res.set = jest.fn(() => res)
  res.send = jest.fn(() => res)
  return res
}

function baseReq(over = {}) {
  return {
    user: { company_id: 1, id: 10, perfil: 'admin', departamento_ids: [] },
    query: {},
    params: {},
    app: { get: () => null },
    get: () => null,
    ...over,
  }
}

describe('chat read handlers — modularização (smoke, sem ReferenceError)', () => {
  let errorSpy
  let warnSpy
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  const assertNoReferenceError = () => {
    const calls = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat()
    for (const arg of calls) {
      const msg = arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)
      expect(msg).not.toMatch(/is not defined|is not a function/i)
    }
  }

  it('reexporta os 4 handlers de leitura', () => {
    expect(typeof chatController.listarConversas).toBe('function')
    expect(typeof chatController.contarConversasPorFiltros).toBe('function')
    expect(typeof chatController.detalharChat).toBe('function')
    expect(typeof chatController.buscarMensagensConversa).toBe('function')
  })

  it('listarConversas executa sem import faltante', async () => {
    const res = makeRes()
    await chatController.listarConversas(baseReq(), res)
    expect(res.json.mock.calls.length + res.status.mock.calls.length).toBeGreaterThan(0)
    assertNoReferenceError()
  })

  it('contarConversasPorFiltros executa sem import faltante', async () => {
    const res = makeRes()
    await chatController.contarConversasPorFiltros(baseReq(), res)
    expect(res.json.mock.calls.length + res.status.mock.calls.length).toBeGreaterThan(0)
    assertNoReferenceError()
  })

  it('detalharChat executa sem import faltante', async () => {
    const res = makeRes()
    await chatController.detalharChat(baseReq({ params: { id: '1' } }), res)
    expect(res.json.mock.calls.length + res.status.mock.calls.length).toBeGreaterThan(0)
    assertNoReferenceError()
  })

  it('buscarMensagensConversa executa sem import faltante', async () => {
    const res = makeRes()
    await chatController.buscarMensagensConversa(baseReq({ params: { id: '1' }, query: { q: 'teste' } }), res)
    expect(res.json.mock.calls.length + res.status.mock.calls.length).toBeGreaterThan(0)
    assertNoReferenceError()
  })
})
