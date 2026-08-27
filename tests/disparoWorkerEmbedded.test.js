/**
 * Loop embarcado do Disparo no processo HTTP.
 * Não inicia envio real: flags de teste ficam em dry-run / live off.
 */

jest.mock('../services/disparoSendService', () => ({
  enviarItemFila: jest.fn().mockResolvedValue({ ok: true, dryRun: true, messageId: 'dry-1' }),
}))

jest.mock('../helpers/disparoWorkerConfig', () => {
  const actual = jest.requireActual('../helpers/disparoWorkerConfig')
  return {
    ...actual,
    getDisparoWorkerConfig: jest.fn(() => ({
      workerEnabled: false,
      liveEnabled: false,
      dryRun: true,
      canSendLive: false,
      pollMs: 60000,
      leaseSeconds: 120,
      batchSize: 1,
      workerId: 'test-embedded',
      sendTimeoutMs: 45000,
      maxTentativas: 5,
      backoffBaseSec: 30,
      backoffMaxSec: 3600,
      allowlist: [],
    })),
  }
})

const supabase = require('../config/supabase')
const worker = require('../workers/disparoWorker')

describe('disparoWorker — loop embarcado no HTTP', () => {
  const envKey = 'DISPARO_EMBEDDED_WORKER'
  let envSnapshot

  beforeEach(() => {
    envSnapshot = process.env[envKey]
    delete process.env[envKey]
    worker.stopEmbeddedWorker()
    supabase.rpc = jest.fn(async () => ({ data: [], error: null }))
  })

  afterEach(() => {
    worker.stopEmbeddedWorker()
    if (envSnapshot === undefined) delete process.env[envKey]
    else process.env[envKey] = envSnapshot
  })

  it('kickWorker é no-op quando o loop não foi iniciado', () => {
    expect(worker.isEmbeddedRunning()).toBe(false)
    expect(worker.kickWorker()).toBe(false)
  })

  it('inicia o loop mesmo com DISPARO_WORKER_ENABLED=false', () => {
    const result = worker.startEmbeddedWorker(null)
    expect(result.started).toBe(true)
    expect(result.skipped).toBe(false)
    expect(worker.isEmbeddedRunning()).toBe(true)
    expect(worker.kickWorker()).toBe(true)
  })

  it('startEmbeddedWorker é idempotente', () => {
    expect(worker.startEmbeddedWorker(null).started).toBe(true)
    const again = worker.startEmbeddedWorker(null)
    expect(again.started).toBe(false)
    expect(again.alreadyRunning).toBe(true)
    expect(worker.isEmbeddedRunning()).toBe(true)
  })

  it('DISPARO_EMBEDDED_WORKER=false impede o loop no HTTP', () => {
    process.env[envKey] = 'false'
    const result = worker.startEmbeddedWorker(null)
    expect(result.started).toBe(false)
    expect(result.skipped).toBe(true)
    expect(worker.isEmbeddedRunning()).toBe(false)
    expect(worker.kickWorker()).toBe(false)
  })

  it('stopEmbeddedWorker encerra o intervalo e o kick volta a ser no-op', () => {
    worker.startEmbeddedWorker(null)
    expect(worker.isEmbeddedRunning()).toBe(true)
    worker.stopEmbeddedWorker()
    expect(worker.isEmbeddedRunning()).toBe(false)
    expect(worker.kickWorker()).toBe(false)
  })
})
