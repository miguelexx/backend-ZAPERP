/**
 * Classificação de saúde do worker de Disparo (heartbeat).
 * Puro: sem HTTP, sem UltraMSG.
 */

const {
  classifyHeartbeat,
  classifyWorkerHealth,
  HEARTBEAT_ATIVO_MS,
  HEARTBEAT_STALE_MS,
  STATUS_ATIVO,
  STATUS_INICIANDO,
  STATUS_SEM_HEARTBEAT,
  STATUS_DESABILITADO,
  STATUS_OFFLINE,
} = require('../helpers/disparoWorkerHealth')

function row(overrides = {}) {
  const now = overrides._now || Date.now()
  const age = overrides._ageMs ?? 5_000
  const bootAge = overrides._bootAgeMs ?? 120_000
  const { _now, _ageMs, _bootAgeMs, meta, ...rest } = overrides
  return {
    worker_id: 'zaperp-disparo-1',
    hostname: 'host',
    pid: 1,
    dry_run: true,
    live_enabled: false,
    ultima_atividade_em: new Date(now - age).toISOString(),
    iniciado_em: new Date(now - bootAge).toISOString(),
    ...rest,
    meta: { status: 'running', workerEnabled: true, ...(meta || {}) },
  }
}

describe('classifyHeartbeat', () => {
  const now = Date.parse('2026-08-28T14:00:00.000Z')

  it('ativo quando heartbeat recente e running', () => {
    expect(classifyHeartbeat(row({ _now: now, _ageMs: 8_000 }), now)).toBe(STATUS_ATIVO)
  })

  it('iniciando nos primeiros 30s após boot', () => {
    expect(classifyHeartbeat(row({
      _now: now,
      _ageMs: 3_000,
      _bootAgeMs: 10_000,
      meta: { status: 'starting', boot: true, workerEnabled: true },
    }), now)).toBe(STATUS_INICIANDO)
  })

  it('sem_heartbeat quando passou da janela ativa mas ainda na stale', () => {
    expect(classifyHeartbeat(row({
      _now: now,
      _ageMs: HEARTBEAT_ATIVO_MS + 5_000,
    }), now)).toBe(STATUS_SEM_HEARTBEAT)
  })

  it('offline quando heartbeat é mais antigo que a janela stale', () => {
    expect(classifyHeartbeat(row({
      _now: now,
      _ageMs: HEARTBEAT_STALE_MS + 1_000,
    }), now)).toBe(STATUS_OFFLINE)
  })

  it('offline no shutdown mesmo com timestamp recente (não esconde alerta)', () => {
    expect(classifyHeartbeat(row({
      _now: now,
      _ageMs: 1_000,
      meta: { status: 'offline', shutdown: true },
    }), now)).toBe(STATUS_OFFLINE)
  })

  it('desabilitado quando o processo está vivo com workerEnabled=false', () => {
    expect(classifyHeartbeat(row({
      _now: now,
      _ageMs: 4_000,
      meta: { status: 'disabled', workerEnabled: false },
    }), now)).toBe(STATUS_DESABILITADO)
  })

  it('null → offline', () => {
    expect(classifyHeartbeat(null, now)).toBe(STATUS_OFFLINE)
  })
})

describe('classifyWorkerHealth — agregação e anti-falso-ativo', () => {
  const now = Date.parse('2026-08-28T14:00:00.000Z')
  const flags = { workerEnabled: true, liveEnabled: false, dryRun: true, canSendLive: false }

  it('saudavel só com worker running recente', () => {
    const saude = classifyWorkerHealth([row({ _now: now })], { now, flags })
    expect(saude.status).toBe(STATUS_ATIVO)
    expect(saude.saudavel).toBe(true)
    expect(saude.workers_ativos).toBe(1)
  })

  it('não marca ativo um shutdown recente', () => {
    const saude = classifyWorkerHealth([row({
      _now: now,
      _ageMs: 500,
      meta: { status: 'offline', shutdown: true },
    })], { now, flags })
    expect(saude.saudavel).toBe(false)
    expect(saude.status).toBe(STATUS_OFFLINE)
    expect(saude.workers_ativos).toBe(0)
    expect(saude.motivo).toMatch(/Nenhum worker ativo detectado/)
  })

  it('lista vazia é offline e não saudável', () => {
    const saude = classifyWorkerHealth([], { now, flags })
    expect(saude.status).toBe(STATUS_OFFLINE)
    expect(saude.saudavel).toBe(false)
    expect(saude.workers_ativos).toBe(0)
  })

  it('running recente prevalece sobre linha stale', () => {
    const saude = classifyWorkerHealth([
      row({ _now: now, _ageMs: HEARTBEAT_ATIVO_MS + 20_000, worker_id: 'old' }),
      row({ _now: now, _ageMs: 2_000, worker_id: 'new' }),
    ], { now, flags })
    expect(saude.status).toBe(STATUS_ATIVO)
    expect(saude.saudavel).toBe(true)
    expect(saude.workers_ativos).toBe(1)
  })

  it('detecta workers live e dry ativos ao mesmo tempo', () => {
    const saude = classifyWorkerHealth([
      row({
        _now: now,
        worker_id: 'live',
        dry_run: false,
        live_enabled: true,
        meta: { status: 'running', workerEnabled: true, canSendLive: true },
      }),
      row({
        _now: now,
        worker_id: 'dry',
        dry_run: true,
        live_enabled: false,
        meta: { status: 'running', workerEnabled: true, canSendLive: false },
      }),
    ], { now, flags })

    expect(saude.workers_live_ativos).toBe(1)
    expect(saude.workers_dry_ativos).toBe(1)
    expect(saude.saudavel_live).toBe(true)
    expect(saude.modos_divergentes).toBe(true)
  })
})
