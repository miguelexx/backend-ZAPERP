/**
 * Worker de Comunidades — lógica pura de avaliação de resultado e gate de ritmo (teto/hora).
 * Supabase/serviços/provider mockados; sem rede nem DB real.
 */

describe('comunidadeWorker', () => {
  let worker
  let countValue

  beforeEach(() => {
    jest.resetModules()
    countValue = 0

    // chain supabase: from().select(...,{count,head}).eq().eq().eq().gte() -> { count }
    const chain = {}
    const ret = () => chain
    chain.from = ret
    chain.select = ret
    chain.eq = ret
    chain.gte = () => Promise.resolve({ count: countValue })
    chain.update = ret
    chain.in = () => Promise.resolve({ data: [], error: null })
    chain.maybeSingle = () => Promise.resolve({ data: { id: 'op1', status: 'em_execucao' }, error: null })
    chain.single = () => Promise.resolve({ data: {}, error: null })
    chain.rpc = jest.fn(async () => ({ data: true, error: null }))

    jest.doMock('../config/supabase', () => chain)
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({ instance: { metadata: {} }, error: null })),
    }))
    jest.doMock('../services/comunidade/comunidadeFilaService', () => ({
      recalcularContadores: jest.fn(async () => ({})),
      pausarOperacaoAutomatica: jest.fn(async () => ({})),
    }))
    jest.doMock('../services/comunidade/comunidadeSocketService', () => ({
      emitComunidade: jest.fn(), EVENTS: {},
    }))

    worker = require('../workers/comunidadeWorker')
  })

  afterEach(() => jest.resetModules())

  test('avaliarResultadoAdd: processed → processed', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { processed: ['553499911246'], failed: [] })).toBe('processed')
  })
  test('avaliarResultadoAdd: failed → failed', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { processed: [], failed: ['553499911246'] })).toBe('failed')
  })
  test('avaliarResultadoAdd: success true sem arrays → processed', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { success: true })).toBe('processed')
  })
  test('avaliarResultadoAdd: success false → failed', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { success: false, processed: [], failed: [] })).toBe('failed')
  })
  test('avaliarResultadoAdd normaliza jid com sufixo @s.whatsapp.net', () => {
    expect(worker.avaliarResultadoAdd('553499911246', { processed: ['553499911246@s.whatsapp.net'], failed: [] })).toBe('processed')
  })

  test('gateDeRitmo barra quando atinge o teto por hora', async () => {
    countValue = 2
    const r = await worker.gateDeRitmo(1, 10, { intervaloMinSec: 30, intervaloMaxSec: 60, porHora: 2, porDia: 100 })
    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('limite_hora')
  })

  test('gateDeRitmo libera quando abaixo dos tetos', async () => {
    countValue = 1
    const r = await worker.gateDeRitmo(1, 10, { intervaloMinSec: 30, intervaloMaxSec: 60, porHora: 20, porDia: 100 })
    expect(r.ok).toBe(true)
  })
})
