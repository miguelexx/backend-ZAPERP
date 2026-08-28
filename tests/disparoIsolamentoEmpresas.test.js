/**
 * Etapa 9 — Isolamento multi-tenant Disparo (company 10 vs 20).
 * Mock Supabase + JWT — sem integração real.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../app')
const supabase = require('../config/supabase')

jest.mock('../services/disparoFilaService', () => ({
  gerarFilaParaCampanha: jest.fn().mockResolvedValue({
    execucao: { id: 50, company_id: 10, campanha_id: 1, versao: 1, status: 'aguardando', dry_run: true },
    gerados: 0,
    ignorados: 0,
    ja_existentes: 0,
    idempotente: false,
  }),
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

jest.mock('../services/disparoRelatorioService', () => ({
  montarRelatorioCampanha: jest.fn().mockResolvedValue({
    campanha_id: 1,
    company_id: 10,
    resumo: { total: 0 },
  }),
  metricasPorInstancia: jest.fn(),
  metricasPorVariacao: jest.fn(),
  listarErrosAgrupados: jest.fn(),
}))

process.env.JWT_SECRET = process.env.JWT_SECRET || 'disparo-isolamento-test-secret'

const COMPANY_A = 10
const COMPANY_B = 20

function token(payload = {}) {
  return jwt.sign(
    { id: 5, company_id: COMPANY_A, perfil: 'admin', ...payload },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  )
}

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit', 'range',
    'insert', 'update', 'upsert', 'gte', 'ilike',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

function expectCompanyFilter(chain, companyId) {
  expect(chain.eq).toHaveBeenCalledWith('company_id', companyId)
  const companyCalls = chain.eq.mock.calls.filter(([col]) => col === 'company_id')
  for (const [, cid] of companyCalls) {
    expect(cid).not.toBe(COMPANY_B === companyId ? COMPANY_A : COMPANY_B)
  }
}

describe('Etapa 9 — Isolamento empresas (10 vs 20)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('GET campanhas company 10 não usa company_id 20', async () => {
    const listQuery = mockChain({
      data: [{ id: 1, company_id: COMPANY_A, nome: 'Camp A', status: 'rascunho' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const res = await request(app)
      .get(`/api/disparo/campanhas?company_id=${COMPANY_B}`)
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_A })}`)

    expect(res.status).toBe(200)
    expectCompanyFilter(listQuery, COMPANY_A)
    expect(listQuery.eq).not.toHaveBeenCalledWith('company_id', COMPANY_B)
  })

  it('GET campanhas company 20 usa apenas company_id 20', async () => {
    const listQuery = mockChain({
      data: [{ id: 2, company_id: COMPANY_B, nome: 'Camp B', status: 'rascunho' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const res = await request(app)
      .get('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_B })}`)

    expect(res.status).toBe(200)
    expectCompanyFilter(listQuery, COMPANY_B)
    expect(listQuery.eq).not.toHaveBeenCalledWith('company_id', COMPANY_A)
  })

  it('POST exclusao usa company_id do token', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_exclusoes') {
        const check = mockChain({ data: null, error: null })
        const insert = mockChain({
          data: {
            id: 99,
            company_id: COMPANY_A,
            telefone_normalizado: '5511999887766',
            ativo: true,
          },
          error: null,
        })
        let calls = 0
        return {
          select: jest.fn(() => {
            calls += 1
            return calls === 1 ? check : insert
          }),
          eq: jest.fn(function eq() { return this || check }),
          insert: jest.fn((payload) => {
            expect(payload.company_id).toBe(COMPANY_A)
            expect(payload.company_id).not.toBe(COMPANY_B)
            return insert
          }),
          single: insert.single,
          maybeSingle: check.maybeSingle,
        }
      }
      return mockChain()
    })

    const res = await request(app)
      .post('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_A })}`)
      .send({ telefone: '11999887766', motivo: 'Teste' })

    expect(res.status).toBe(201)
  })

  it('POST execucao/iniciar repassa companyId do token ao serviço', async () => {
    const campanha = {
      id: 1,
      company_id: COMPANY_A,
      nome: 'Camp',
      status: 'pronta',
      versao_atual: 1,
      config_hash: 'h1',
    }

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        const fetch = mockChain({ data: campanha, error: null })
        const update = mockChain({ data: null, error: null })
        return {
          select: jest.fn(() => fetch),
          update: jest.fn(() => update),
          eq: jest.fn(() => fetch),
        }
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: {
            id: 50,
            company_id: COMPANY_A,
            campanha_id: 1,
            versao: 1,
            status: 'em_execucao',
            dry_run: true,
          },
          error: null,
        })
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_worker_heartbeat') {
        const agora = new Date().toISOString()
        return mockChain({
          data: [{
            worker_id: 'w1',
            hostname: 'host',
            pid: 1,
            dry_run: true,
            live_enabled: false,
            ultima_atividade_em: agora,
            iniciado_em: new Date(Date.now() - 120000).toISOString(),
            meta: { status: 'running', workerEnabled: true, canSendLive: false },
          }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    const { gerarFilaParaCampanha } = require('../services/disparoFilaService')

    const res = await request(app)
      .post('/api/disparo/campanhas/1/execucao/iniciar')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_A })}`)

    expect(res.status).toBe(200)
    expect(gerarFilaParaCampanha).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_A }),
    )
    expect(gerarFilaParaCampanha).not.toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_B }),
    )
  })

  it('GET relatorio repassa company_id do token ao serviço', async () => {
    const { montarRelatorioCampanha } = require('../services/disparoRelatorioService')

    const res = await request(app)
      .get('/api/disparo/campanhas/1/relatorio')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_A })}`)

    expect(res.status).toBe(200)
    expect(montarRelatorioCampanha).toHaveBeenCalledWith(1, COMPANY_A)
    expect(montarRelatorioCampanha).not.toHaveBeenCalledWith(1, COMPANY_B)
  })

  it('403 atendente em GET /saude', async () => {
    const res = await request(app)
      .get('/api/disparo/saude')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('403 atendente em GET campanhas', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })
})

describe('Etapa 9 — GET /disparo/saude', () => {
  beforeEach(() => jest.clearAllMocks())

  it('retorna flags e contagens sem expor tokens', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: null, error: null, count: 3 })
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockChain({
          data: [{
            worker_id: 'w1',
            hostname: 'host',
            pid: 1,
            dry_run: true,
            live_enabled: false,
            ultima_atividade_em: new Date().toISOString(),
            iniciado_em: new Date().toISOString(),
            meta: { canSendLive: false },
          }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null, count: 0 })
    })

    const res = await request(app)
      .get('/api/disparo/saude')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_A })}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.company_id).toBe(COMPANY_A)
    expect(res.body.flags).toMatchObject({
      workerEnabled: expect.any(Boolean),
      liveEnabled: expect.any(Boolean),
      dryRun: expect.any(Boolean),
      canSendLive: expect.any(Boolean),
    })
    expect(res.body.janela_minutos).toBe(10)
    expect(typeof res.body.fila_pendente).toBe('number')
    expect(typeof res.body.incertos).toBe('number')
    expect(res.body.workers_ativos).toBeGreaterThanOrEqual(0)
    expect(['ativo', 'iniciando', 'sem_heartbeat', 'desabilitado', 'offline']).toContain(res.body.worker_status)
    expect(JSON.stringify(res.body)).not.toMatch(/WHATSAPP_WEBHOOK_TOKEN|JWT_SECRET|token/i)
  })
})
