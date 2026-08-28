/**
 * Heartbeat, recuperação de reservas e isolamento de erro por item.
 */

jest.mock('../services/disparoSendService', () => ({
  enviarItemFila: jest.fn().mockResolvedValue({ ok: true, dryRun: true, messageId: 'dry-1' }),
}))

jest.mock('../helpers/disparoWorkerConfig', () => ({
  getDisparoWorkerConfig: jest.fn(() => ({
    workerEnabled: true,
    liveEnabled: false,
    dryRun: true,
    canSendLive: false,
    pollMs: 2000,
    heartbeatMs: 10000,
    leaseSeconds: 120,
    batchSize: 5,
    workerId: 'test-worker',
    sendTimeoutMs: 45000,
    maxTentativas: 5,
    backoffBaseSec: 30,
    backoffMaxSec: 3600,
    allowlist: [],
  })),
}))

const supabase = require('../config/supabase')
const worker = require('../workers/disparoWorker')

function installRpcMock(handlers = {}) {
  supabase.rpc = jest.fn(async (name, params) => {
    if (handlers[name]) return handlers[name](params)
    return { data: null, error: null }
  })
}

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = ['select', 'eq', 'in', 'order', 'limit', 'update', 'upsert', 'insert', 'gte']
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('disparoWorker — heartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('registra erro do Supabase no upsert (não engole error)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    supabase.from.mockImplementation(() => {
      const chain = mockChain({ data: null, error: { message: 'relation does not exist' } })
      return chain
    })

    const ok = await worker.heartbeat({ boot: true })
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[disparoWorker] heartbeat falhou:',
      'relation does not exist',
    )
    warn.mockRestore()
  })

  it('heartbeatStatus running no estado normal', () => {
    expect(worker.heartbeatStatus()).toBe('running')
    expect(worker.heartbeatStatus({ boot: true })).toBe('starting')
    expect(worker.heartbeatStatus({ shutdown: true })).toBe('offline')
    expect(worker.heartbeatStatus({ status: 'disabled' })).toBe('disabled')
  })

  it('startDisparoWorker é idempotente e stop limpa o loop', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    supabase.from.mockImplementation(() => mockChain())
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({ data: 0, error: null }),
      disparo_claim_fila_itens: () => ({ data: [], error: null }),
    })
    try {
      const stop = worker.startDisparoWorker()
      const stop2 = worker.startDisparoWorker()
      expect(stop).toBe(stop2)
      await worker.stopDisparoWorker()
    } finally {
      await worker.stopDisparoWorker().catch(() => {})
      log.mockRestore()
      err.mockRestore()
      warn.mockRestore()
    }
  })
})

describe('disparoWorker — liberarReservas e erro por item', () => {
  const itemSample = {
    id: 1,
    company_id: 10,
    campanha_id: 1,
    execucao_id: 50,
    instancia_id: 5,
    destinatario_id: 100,
    variacao_id: 30,
    status: 'reservada',
    tentativas: 0,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    supabase.from.mockImplementation(() => mockChain())
  })

  it('liberarReservas ignora itens já em enviando', async () => {
    const ins = []
    supabase.from.mockImplementation((table) => {
      const chain = mockChain()
      if (table === 'disparo_fila_itens') {
        chain.update = jest.fn((payload) => {
          ins.push(payload)
          return chain
        })
      }
      return chain
    })

    await worker.liberarReservas([
      { id: 10, status: 'reservada' },
      { id: 11, status: 'enviando' },
    ])

    expect(ins).toHaveLength(1)
    expect(ins[0].status).toBe('pendente')
    const filaChainCalls = supabase.from.mock.results
    expect(supabase.from).toHaveBeenCalledWith('disparo_fila_itens')
    const chain = filaChainCalls.find(() => true)
    expect(chain).toBeTruthy()
  })

  it('tick continua o lote se o primeiro item lançar', async () => {
    let lockCalls = 0
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({ data: 0, error: null }),
      disparo_claim_fila_itens: () => ({
        data: [
          { ...itemSample, id: 1 },
          { ...itemSample, id: 2 },
        ],
        error: null,
      }),
      disparo_try_lock_instancia: async () => {
        lockCalls += 1
        if (lockCalls === 1) throw new Error('lock boom')
        return { data: true, error: null }
      },
      disparo_unlock_instancia: () => ({ data: true, error: null }),
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { fuso_horario: 'America/Sao_Paulo' }, error: null })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_instancia_limites') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({ data: { id: 50, status: 'em_execucao', dry_run: true }, error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: { id: 5, status: 'connected', ativo: true, nome: 'A' }, error: null })
      }
      return mockChain()
    })

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await worker.tick()
    errSpy.mockRestore()

    expect(lockCalls).toBe(2)
  })
})
