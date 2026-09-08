/**
 * Guarda anti-ban do disparo: avaliarAntiban consulta getReachoutTimelock/getNewChatLimit
 * do provider da instância e freia se capado/restrito. Opt-in (env), provider-aware, fail-open.
 * Ver doc 25 §30 + services/disparoAntibanGuardService.js.
 */

describe('disparoAntibanGuardService.avaliarAntiban', () => {
  let providerMock
  beforeEach(() => {
    jest.resetModules()
    providerMock = {}
    jest.doMock('../services/providers', () => ({
      getProvider: jest.fn(() => providerMock),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => 'whapi'),
    }))
  })
  afterEach(() => {
    delete process.env.WHAPI_ANTIBAN_GATE_ENABLED
    jest.resetModules()
  })

  function load() {
    const svc = require('../services/disparoAntibanGuardService')
    svc._resetCache()
    return svc
  }

  test('desligado por padrão (env off) → libera sem consultar provider', async () => {
    providerMock.getReachoutTimelock = jest.fn()
    providerMock.getNewChatLimit = jest.fn()
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(true)
    expect(providerMock.getReachoutTimelock).not.toHaveBeenCalled()
  })

  test('ligado + timelock restrito → freia até restricted_until', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock.getReachoutTimelock = jest.fn(async () => ({ ok: true, restricted: true, restrictedUntil: 1893456000, restrictionType: 'biz_quality' }))
    providerMock.getNewChatLimit = jest.fn(async () => ({ ok: true, capped: false }))
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(false)
    expect(r.proxima_tentativa_em).toBe(new Date(1893456000 * 1000).toISOString())
    expect(providerMock.getNewChatLimit).not.toHaveBeenCalled() // curto-circuito
  })

  test('ligado + novos chats capados → freia até cycle_end_at', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock.getReachoutTimelock = jest.fn(async () => ({ ok: true, restricted: false }))
    providerMock.getNewChatLimit = jest.fn(async () => ({ ok: true, capped: true, capStatus: 'capped', cycleEndAt: 1893456000 }))
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/Limite de novos chats/)
  })

  test('ligado + sem restrição → libera', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock.getReachoutTimelock = jest.fn(async () => ({ ok: true, restricted: false }))
    providerMock.getNewChatLimit = jest.fn(async () => ({ ok: true, capped: false }))
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(true)
  })

  test('provider sem os métodos (UltraMSG) → no-op mesmo com env on', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock = {} // sem getReachoutTimelock/getNewChatLimit
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(true)
  })

  test('fail-open: erro ao consultar libera o envio', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock.getReachoutTimelock = jest.fn(async () => { throw new Error('timeout') })
    providerMock.getNewChatLimit = jest.fn(async () => ({ ok: true, capped: false }))
    const svc = load()
    const r = await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(r.ok).toBe(true)
  })

  test('cache: segunda chamada não reconsulta dentro do TTL', async () => {
    process.env.WHAPI_ANTIBAN_GATE_ENABLED = 'true'
    providerMock.getReachoutTimelock = jest.fn(async () => ({ ok: true, restricted: false }))
    providerMock.getNewChatLimit = jest.fn(async () => ({ ok: true, capped: false }))
    const svc = load()
    await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    await svc.avaliarAntiban({ companyId: 1, instanciaId: 10 })
    expect(providerMock.getReachoutTimelock).toHaveBeenCalledTimes(1)
  })
})
