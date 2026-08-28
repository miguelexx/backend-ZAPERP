/**
 * Com DISPARO_WORKER_ENABLED=false o tick não claima a fila.
 */

jest.mock('../helpers/disparoWorkerConfig', () => ({
  getDisparoWorkerConfig: jest.fn(() => ({
    workerEnabled: false,
    liveEnabled: false,
    dryRun: true,
    canSendLive: false,
    pollMs: 2000,
    heartbeatMs: 10000,
    leaseSeconds: 120,
    batchSize: 5,
    workerId: 'test-worker-disabled',
    sendTimeoutMs: 45000,
    maxTentativas: 5,
    backoffBaseSec: 30,
    backoffMaxSec: 3600,
    allowlist: [],
  })),
}))

const supabase = require('../config/supabase')
const worker = require('../workers/disparoWorker')

describe('disparoWorker — desabilitado não processa fila', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    supabase.rpc = jest.fn().mockResolvedValue({ data: [], error: null })
  })

  it('tick retorna sem claim nem recovery', async () => {
    await worker.tick()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('heartbeatStatus reflete disabled', () => {
    expect(worker.heartbeatStatus()).toBe('disabled')
  })
})
