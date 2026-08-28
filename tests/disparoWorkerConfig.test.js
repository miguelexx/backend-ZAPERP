/**
 * Testes unitários — flags e config do worker Disparo (Etapa 7).
 * Puros: save/restore de process.env, sem HTTP/UltraMSG.
 */

const {
  getDisparoFlags,
  getDisparoWorkerConfig,
  telefoneNaAllowlist,
  getBooleanEnv,
  getIntEnv,
} = require('../helpers/disparoWorkerConfig')

const ENV_KEYS = [
  'DISPARO_WORKER_ENABLED',
  'DISPARO_LIVE_ENABLED',
  'DISPARO_DRY_RUN',
  'DISPARO_TEST_ALLOWLIST',
  'DISPARO_WORKER_POLL_MS',
  'DISPARO_WORKER_LEASE_SECONDS',
  'DISPARO_WORKER_BATCH_SIZE',
  'DISPARO_WORKER_ID',
  'DISPARO_WORKER_HEARTBEAT_MS',
  'DISPARO_SEND_TIMEOUT_MS',
  'DISPARO_MAX_TENTATIVAS',
  'DISPARO_BACKOFF_BASE_SEC',
  'DISPARO_BACKOFF_MAX_SEC',
]

let savedEnv = {}

function snapshotEnv() {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

function clearDisparoEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('disparoWorkerConfig — defaults seguros', () => {
  beforeEach(() => {
    snapshotEnv()
    clearDisparoEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  it('defaults: worker true, live false, dryRun true, canSendLive false', () => {
    const flags = getDisparoFlags()
    expect(flags.workerEnabled).toBe(true)
    expect(flags.liveEnabled).toBe(false)
    expect(flags.dryRun).toBe(true)
    expect(flags.canSendLive).toBe(false)
  })

  it('canSendLive true somente com WORKER + LIVE + DRY_RUN=false', () => {
    process.env.DISPARO_WORKER_ENABLED = 'true'
    process.env.DISPARO_LIVE_ENABLED = 'true'
    process.env.DISPARO_DRY_RUN = 'false'
    expect(getDisparoFlags().canSendLive).toBe(true)

    process.env.DISPARO_DRY_RUN = 'true'
    expect(getDisparoFlags().canSendLive).toBe(false)

    process.env.DISPARO_DRY_RUN = 'false'
    process.env.DISPARO_LIVE_ENABLED = 'false'
    expect(getDisparoFlags().canSendLive).toBe(false)

    process.env.DISPARO_LIVE_ENABLED = 'true'
    process.env.DISPARO_WORKER_ENABLED = 'false'
    expect(getDisparoFlags().canSendLive).toBe(false)
  })

  it('getBooleanEnv interpreta variantes comuns', () => {
    process.env.DISPARO_WORKER_ENABLED = '1'
    expect(getBooleanEnv('DISPARO_WORKER_ENABLED', false)).toBe(true)
    process.env.DISPARO_WORKER_ENABLED = 'yes'
    expect(getBooleanEnv('DISPARO_WORKER_ENABLED', false)).toBe(true)
    process.env.DISPARO_WORKER_ENABLED = 'off'
    expect(getBooleanEnv('DISPARO_WORKER_ENABLED', true)).toBe(false)
    delete process.env.DISPARO_WORKER_ENABLED
    expect(getBooleanEnv('DISPARO_WORKER_ENABLED', true)).toBe(true)
  })

  it('getIntEnv respeita min/max e default', () => {
    process.env.DISPARO_WORKER_POLL_MS = '100'
    expect(getIntEnv('DISPARO_WORKER_POLL_MS', 2000, 500, 60000)).toBe(500)
    process.env.DISPARO_WORKER_POLL_MS = '999999'
    expect(getIntEnv('DISPARO_WORKER_POLL_MS', 2000, 500, 60000)).toBe(60000)
    delete process.env.DISPARO_WORKER_POLL_MS
    expect(getIntEnv('DISPARO_WORKER_POLL_MS', 2000, 500, 60000)).toBe(2000)
  })
})

describe('disparoWorkerConfig — allowlist e config completa', () => {
  beforeEach(() => {
    snapshotEnv()
    clearDisparoEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  it('allowlist vazia → telefoneNaAllowlist sempre true', () => {
    expect(telefoneNaAllowlist('5511999887766', [])).toBe(true)
    expect(telefoneNaAllowlist('5511999887766', null)).toBe(true)
  })

  it('parseia allowlist com vírgula, ponto-e-vírgula e espaços como separadores', () => {
    // Espaços separam tokens — telefones compactos evitam split interno
    process.env.DISPARO_TEST_ALLOWLIST = '5511999887766;34999887766, 11987654321'
    const cfg = getDisparoWorkerConfig()
    expect(cfg.allowlist).toEqual(['5511999887766', '34999887766', '11987654321'])
  })

  it('remove não-dígitos de cada token da allowlist', () => {
    process.env.DISPARO_TEST_ALLOWLIST = '+55(11)99988-7766'
    const cfg = getDisparoWorkerConfig()
    expect(cfg.allowlist).toEqual(['5511999887766'])
  })

  it('telefoneNaAllowlist faz match por sufixo', () => {
    const allowlist = ['999887766']
    expect(telefoneNaAllowlist('5511999887766', allowlist)).toBe(true)
    expect(telefoneNaAllowlist('5511888776655', allowlist)).toBe(false)
  })

  it('getDisparoWorkerConfig inclui flags e parâmetros numéricos', () => {
    process.env.DISPARO_WORKER_POLL_MS = '3000'
    process.env.DISPARO_WORKER_BATCH_SIZE = '10'
    const cfg = getDisparoWorkerConfig()
    expect(cfg.pollMs).toBe(3000)
    expect(cfg.batchSize).toBe(10)
    expect(cfg.heartbeatMs).toBe(10000)
    expect(cfg.workerEnabled).toBe(true)
    expect(cfg.dryRun).toBe(true)
    expect(typeof cfg.workerId).toBe('string')
    expect(cfg.workerId.length).toBeGreaterThan(0)
  })

  it('não muta process.env permanentemente após restore', () => {
    const before = process.env.DISPARO_WORKER_ENABLED
    process.env.DISPARO_WORKER_ENABLED = 'true'
    restoreEnv()
    if (before === undefined) {
      expect(process.env.DISPARO_WORKER_ENABLED).toBeUndefined()
    } else {
      expect(process.env.DISPARO_WORKER_ENABLED).toBe(before)
    }
  })
})
