/**
 * Testes API — Execução / fila Disparo (Etapa 7).
 * Mocks Supabase — sem envio real.
 */

jest.mock('../services/disparoFilaService', () => ({
  gerarFilaParaCampanha: jest.fn(),
  registrarEvento: jest.fn().mockResolvedValue(undefined),
  recalcularContadores: jest.fn().mockResolvedValue({}),
  DisparoFilaError: class DisparoFilaError extends Error {
    constructor(message, code = 'VALIDATION') {
      super(message)
      this.name = 'DisparoFilaError'
      this.code = code
    }
  },
}))

jest.mock('../controllers/disparoLimitesController', () => ({
  ...jest.requireActual('../controllers/disparoLimitesController'),
  revalidarInstanciasConectadas: jest.fn().mockResolvedValue({ ok: true, desconectadas: [] }),
}))

jest.mock('../services/operationalAuditService', () => ({
  registrarEvento: jest.fn().mockResolvedValue(undefined),
}))

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../app')
const supabase = require('../config/supabase')
const { gerarFilaParaCampanha } = require('../services/disparoFilaService')

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
const COMPANY_ID = 10

function token(extra = {}) {
  return jwt.sign({ id: 5, company_id: COMPANY_ID, perfil: 'admin', ...extra }, JWT_SECRET, { expiresIn: '1h' })
}

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'not', 'in', 'order', 'limit', 'range',
    'insert', 'update', 'upsert', 'gte',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

function mockHeartbeatSaudavel() {
  return mockChain({
    data: [{
      worker_id: 'zaperp-disparo-1',
      hostname: 'test-host',
      pid: 42,
      dry_run: true,
      live_enabled: false,
      ultima_atividade_em: new Date().toISOString(),
      iniciado_em: new Date(Date.now() - 120000).toISOString(),
      meta: { status: 'running', workerEnabled: true, canSendLive: false },
    }],
    error: null,
  })
}

const campanhaPronta = {
  id: 1,
  company_id: COMPANY_ID,
  nome: 'Campanha Teste',
  status: 'pronta',
  versao_atual: 1,
  config_hash: 'hash1',
}

describe('Etapa 7 Execução — auth', () => {
  beforeEach(() => jest.clearAllMocks())

  it('401 sem token em POST iniciar', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/execucao/iniciar')
    expect(res.status).toBe(401)
  })

  it('403 atendente em GET execucao', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/execucao')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('403 supervisor em POST pausar', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/pausar')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
    expect(res.status).toBe(403)
  })
})

describe('Etapa 7 Execução — iniciar campanha', () => {
  // Este bloco valida o comportamento com flags DEFAULT (dry-run on, live off). Não pode
  // depender do .env local, que na máquina do dev pode ligar o disparo (DISPARO_LIVE_ENABLED=true,
  // DISPARO_DRY_RUN=false). Forçamos os defaults seguros e restauramos o env após cada teste.
  const disparoEnvKeys = ['DISPARO_WORKER_ENABLED', 'DISPARO_LIVE_ENABLED', 'DISPARO_DRY_RUN']
  let disparoEnvSnapshot
  beforeEach(() => {
    jest.clearAllMocks()
    disparoEnvSnapshot = disparoEnvKeys.map((k) => [k, process.env[k]])
    process.env.DISPARO_WORKER_ENABLED = 'false'
    process.env.DISPARO_LIVE_ENABLED = 'false'
    process.env.DISPARO_DRY_RUN = 'true'
  })
  afterEach(() => {
    for (const [k, v] of disparoEnvSnapshot) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('inicia campanha pronta com dry_run true (flags default)', async () => {
    gerarFilaParaCampanha.mockResolvedValue({
      execucao: {
        id: 50,
        company_id: COMPANY_ID,
        campanha_id: 1,
        versao: 1,
        status: 'aguardando',
        dry_run: true,
      },
      gerados: 10,
      ignorados: 0,
      ja_existentes: 0,
      idempotente: false,
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        const fetch = mockChain({ data: campanhaPronta, error: null })
        const update = mockChain({ data: null, error: null })
        let phase = 'fetch'
        return {
          select: jest.fn(() => fetch),
          update: jest.fn(() => update),
          eq: jest.fn(() => (phase === 'fetch' ? fetch : update)),
        }
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: {
            id: 50,
            company_id: COMPANY_ID,
            campanha_id: 1,
            versao: 1,
            status: 'em_execucao',
            dry_run: true,
            iniciado_em: '2026-08-22T12:00:00.000Z',
          },
          error: null,
        })
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockHeartbeatSaudavel()
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.campanha_status).toBe('em_execucao')
    expect(res.body.execucao.dry_run).toBe(true)
    expect(res.body.flags.dryRun).toBe(true)
    expect(res.body.flags.canSendLive).toBe(false)
    expect(gerarFilaParaCampanha).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, campanhaId: 1 }),
    )
  })

  it('recusa iniciar quando nenhum worker saudável (heartbeat ausente)', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockChain({ data: [], error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WORKER_OFFLINE')
    expect(res.body.error).toMatch(/Nenhum worker ativo detectado/i)
    expect(gerarFilaParaCampanha).not.toHaveBeenCalled()
  })

  it('recusa execução live quando só existe worker dry-run ativo', async () => {
    process.env.DISPARO_WORKER_ENABLED = 'true'
    process.env.DISPARO_LIVE_ENABLED = 'true'
    process.env.DISPARO_DRY_RUN = 'false'

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockHeartbeatSaudavel()
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WORKER_LIVE_OFFLINE')
    expect(res.body.error).toMatch(/envio live habilitado/i)
    expect(gerarFilaParaCampanha).not.toHaveBeenCalled()
  })

  it('idempotente quando campanha já em_execucao', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { ...campanhaPronta, status: 'em_execucao' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: { id: 50, status: 'em_execucao', dry_run: true },
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.idempotente).toBe(true)
    expect(gerarFilaParaCampanha).not.toHaveBeenCalled()
  })

  it('devolve 422 (não 500) quando a geração da fila falha com DisparoFilaError', async () => {
    const { DisparoFilaError } = require('../services/disparoFilaService')
    gerarFilaParaCampanha.mockRejectedValue(
      new DisparoFilaError('Instância WhatsApp ausente ou de outro tenant. Volte à etapa de instâncias.', 'DB'),
    )

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockHeartbeatSaudavel()
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/instância/i)
  })
})

describe('Etapa 7 Execução — pausar e cancelar', () => {
  beforeEach(() => jest.clearAllMocks())

  it('pausa campanha em execução', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { ...campanhaPronta, status: 'em_execucao' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: { id: 50, status: 'em_execucao', company_id: COMPANY_ID },
          error: null,
        })
      }
      if (table === 'disparo_pausas') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/pausar')
      .set('Authorization', `Bearer ${token()}`)
      .send({ motivo: 'Teste pausa' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe('pausada')
  })

  it('cancelar exige confirmacao: true', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/cancelar')
      .set('Authorization', `Bearer ${token()}`)
      .send({})

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/confirmação/i)
  })

  it('cancelar com confirmação cancela campanha', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { ...campanhaPronta, status: 'em_execucao' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({ data: { id: 50, status: 'em_execucao' }, error: null })
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: [{ id: 1, status: 'pendente' }], error: null })
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/cancelar')
      .set('Authorization', `Bearer ${token()}`)
      .send({ confirmacao: true })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe('cancelada')
  })
})

describe('Etapa 7 Execução — emergência (isolada por company)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('emergência exige confirmacao EMERGENCIA', async () => {
    const res = await request(app)
      .post('/api/disparo/execucao/emergencia')
      .set('Authorization', `Bearer ${token()}`)
      .send({ confirmacao: 'errado' })

    expect(res.status).toBe(422)
  })

  it('emergência cancela execuções ativas da empresa do token', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_execucoes') {
        const chain = mockChain({
          data: [
            { id: 50, campanha_id: 1, status: 'em_execucao' },
            { id: 51, campanha_id: 2, status: 'pausada' },
          ],
          error: null,
        })
        chain.in = jest.fn(() => chain)
        chain.eq = jest.fn(() => chain)
        chain.select = jest.fn(() => chain)
        chain.then = (resolve) => Promise.resolve({
          data: [
            { id: 50, campanha_id: 1, status: 'em_execucao' },
            { id: 51, campanha_id: 2, status: 'pausada' },
          ],
          error: null,
        }).then(resolve)
        return chain
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_pausas') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_campanhas') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/execucao/emergencia')
      .set('Authorization', `Bearer ${token()}`)
      .send({ confirmacao: 'EMERGENCIA' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execucoes_afetadas).toBe(2)
    expect(res.body.campanhas_afetadas).toBe(2)
  })
})

describe('Etapa 7 Execução — GET /worker/saude', () => {
  beforeEach(() => jest.clearAllMocks())

  it('403 atendente', async () => {
    const res = await request(app)
      .get('/api/disparo/worker/saude')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('classifica worker ativo com heartbeat recente running', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_worker_heartbeat') return mockHeartbeatSaudavel()
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .get('/api/disparo/worker/saude')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ativo')
    expect(res.body.saudavel).toBe(true)
    expect(res.body.workers_ativos).toBeGreaterThanOrEqual(1)
  })

  it('classifica offline quando não há heartbeat', async () => {
    supabase.from.mockImplementation(() => mockChain({ data: [], error: null }))

    const res = await request(app)
      .get('/api/disparo/worker/saude')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('offline')
    expect(res.body.saudavel).toBe(false)
    expect(res.body.motivo).toMatch(/Nenhum worker ativo detectado/i)
    expect(res.body.workers_ativos).toBe(0)
  })

  it('não marca ativo um heartbeat de shutdown recente', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_worker_heartbeat') {
        return mockChain({
          data: [{
            worker_id: 'zaperp-disparo-1',
            hostname: 'test-host',
            pid: 42,
            dry_run: true,
            live_enabled: false,
            ultima_atividade_em: new Date().toISOString(),
            iniciado_em: new Date(Date.now() - 120000).toISOString(),
            meta: { status: 'offline', shutdown: true },
          }],
          error: null,
        })
      }
      return mockChain({ data: [], error: null })
    })

    const res = await request(app)
      .get('/api/disparo/worker/saude')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.saudavel).toBe(false)
    expect(res.body.status).toBe('offline')
  })
})
