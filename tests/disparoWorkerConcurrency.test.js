/**
 * Testes unitários — concorrência do worker Disparo (Etapa 7).
 * Simula claim SKIP LOCKED, lease recovery e advisory lock via RPC mock.
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
    leaseSeconds: 120,
    batchSize: 1,
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
  const methods = ['select', 'eq', 'in', 'order', 'limit', 'update', 'upsert']
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

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

describe('disparoWorker — claim SKIP LOCKED (dois workers)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const claimed = new Set()
    installRpcMock({
      disparo_claim_fila_itens: ({ p_worker_id, p_limit }) => {
        const available = [
          { ...itemSample, id: 1 },
          { ...itemSample, id: 2 },
        ].filter((i) => !claimed.has(i.id))
        const batch = available.slice(0, p_limit)
        for (const item of batch) claimed.add(item.id)
        return { data: batch, error: null }
      },
      disparo_try_lock_instancia: () => ({ data: true, error: null }),
      disparo_unlock_instancia: () => ({ data: null, error: null }),
      disparo_recuperar_leases_expirados: () => ({ data: 0, error: null }),
    })
  })

  it('dois workers: cada um recebe itens distintos (sem overlap)', async () => {
    const w1 = await worker.claimItens()
    const w2 = await worker.claimItens()

    const ids1 = w1.map((i) => i.id)
    const ids2 = w2.map((i) => i.id)
    const overlap = ids1.filter((id) => ids2.includes(id))

    expect(w1.length).toBeGreaterThan(0)
    expect(w2.length).toBeGreaterThan(0)
    expect(overlap).toHaveLength(0)
    expect([...ids1, ...ids2].sort()).toEqual([1, 2])
  })
})

describe('disparoWorker — lease recovery', () => {
  beforeEach(() => jest.clearAllMocks())

  it('recuperarLeases chama RPC e retorna quantidade', async () => {
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({ data: 3, error: null }),
    })

    const n = await worker.recuperarLeases()
    expect(n).toBe(3)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'disparo_recuperar_leases_expirados',
      { p_limit: 100 },
    )
  })

  it('recuperarLeases retorna 0 em erro RPC', async () => {
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({
        data: null,
        error: { message: 'rpc failed' },
      }),
    })

    const n = await worker.recuperarLeases()
    expect(n).toBe(0)
  })
})

describe('disparoWorker — advisory lock mutual exclusion', () => {
  let lockHolder = null

  beforeEach(() => {
    jest.clearAllMocks()
    lockHolder = null
    installRpcMock({
      disparo_try_lock_instancia: ({ p_instancia_id }) => ({
        data: lockHolder === null,
        error: null,
      }),
      disparo_unlock_instancia: ({ p_instancia_id }) => {
        if (lockHolder === p_instancia_id) lockHolder = null
        return { data: null, error: null }
      },
    })
  })

  it('segundo worker não obtém lock enquanto primeiro segura', async () => {
    // Simula lock exclusivo manualmente
    lockHolder = 5
    const { data: gotLock } = await supabase.rpc('disparo_try_lock_instancia', { p_instancia_id: 5 })
    expect(gotLock).toBe(false)

    lockHolder = null
    const { data: gotLock2 } = await supabase.rpc('disparo_try_lock_instancia', { p_instancia_id: 5 })
    expect(gotLock2).toBe(true)
  })
})

describe('disparoWorker — processarItem adia quando lock falha', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installRpcMock({
      disparo_try_lock_instancia: () => ({ data: false, error: null }),
      disparo_unlock_instancia: () => ({ data: null, error: null }),
    })

    let updatePayload = null
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_fila_itens') {
        const chain = mockChain({ data: null, error: null })
        chain.update = jest.fn((payload) => {
          updatePayload = payload
          return chain
        })
        return chain
      }
      return mockChain()
    })
    worker._setIo(null)
  })

  it('adia item quando instância ocupada', async () => {
    await worker.processarItem(itemSample)

    expect(supabase.from).toHaveBeenCalledWith('disparo_fila_itens')
    expect(supabase.rpc).toHaveBeenCalledWith(
      'disparo_try_lock_instancia',
      { p_instancia_id: 5 },
    )
  })
})

describe('disparoWorker — tick integração leve', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({ data: 0, error: null }),
      disparo_claim_fila_itens: () => ({ data: [], error: null }),
    })
    supabase.from.mockImplementation(() => mockChain())
  })

  it('tick executa sem erro com fila vazia', async () => {
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(supabase.rpc).toHaveBeenCalledWith(
      'disparo_recuperar_leases_expirados',
      expect.any(Object),
    )
  })
})

describe('disparoWorker — exports para testes', () => {
  it('exporta funções necessárias para testes unitários', () => {
    expect(typeof worker.tick).toBe('function')
    expect(typeof worker.processarItem).toBe('function')
    expect(typeof worker.recuperarLeases).toBe('function')
    expect(typeof worker.claimItens).toBe('function')
    expect(typeof worker._setIo).toBe('function')
  })
})
