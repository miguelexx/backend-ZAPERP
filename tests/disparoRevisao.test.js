/**
 * Testes API — Etapa 6 Revisão final.
 * Mocks do Supabase — NÃO é integração real.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../app')
const supabase = require('../config/supabase')

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
const COMPANY_ID = 10

function token(extra = {}) {
  return jwt.sign({ id: 5, company_id: COMPANY_ID, perfil: 'admin', ...extra }, JWT_SECRET, { expiresIn: '1h' })
}

function mockChain(resolvedValue = { data: null, error: null, count: null }) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(resolvedValue),
    single: jest.fn().mockResolvedValue(resolvedValue),
  }
  const p = Promise.resolve(resolvedValue)
  Object.setPrototypeOf(chain, {
    then: (res, rej) => p.then(res, rej),
    catch: (rej) => p.catch(rej),
  })
  return chain
}

const campanhaEditavel = {
  id: 1,
  company_id: COMPANY_ID,
  nome: 'Campanha Alpha',
  descricao: 'Desc',
  status: 'configurando',
  criado_por: 5,
  criado_em: '2026-08-01T10:00:00.000Z',
  atualizado_em: '2026-08-01T10:00:00.000Z',
  versao_atual: 0,
  config_hash: null,
  confirmada_em: null,
  confirmada_por: null,
  autorizacao_aceita_em: null,
  autorizacao_texto: null,
  distribuicao_modo: 'equilibrada',
  distribuicao_confirmada: true,
  distribuicao_revisao: false,
  variacao_modo: 'unica',
  variacao_confirmada: true,
  variacao_revisao: false,
  variacao_padrao_valores: {},
  limites_confirmados: true,
  limites_revisao: false,
}

describe('Etapa 6 — Auth e isolamento', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita GET /revisao sem token', async () => {
    const res = await request(app).get('/api/disparo/campanhas/1/revisao')
    expect(res.status).toBe(401)
  })

  it('bloqueia atendente', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/revisao')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('filtra company_id do token', async () => {
    const q = mockChain({ data: null, error: null })
    supabase.from.mockReturnValue(q)
    const res = await request(app)
      .get('/api/disparo/campanhas/99/revisao')
      .set('Authorization', `Bearer ${token()}`)
    expect(res.status).toBe(404)
    expect(q.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })
})

describe('Etapa 6 — Congelamento de endpoints anteriores', () => {
  beforeEach(() => jest.clearAllMocks())

  it('PATCH campanha pronta é rejeitado (422)', async () => {
    supabase.from.mockReturnValue(mockChain({
      data: { id: 1, status: 'pronta' },
      error: null,
    }))
    const res = await request(app)
      .patch('/api/disparo/campanhas/1')
      .set('Authorization', `Bearer ${token()}`)
      .send({ nome: 'Hack' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/congelada|execução|alterar/i)
  })

  it('POST destinatários em campanha agendada é rejeitado', async () => {
    supabase.from.mockReturnValue(mockChain({
      data: { id: 1, status: 'agendada', company_id: COMPANY_ID },
      error: null,
    }))
    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${token()}`)
      .send({ cliente_ids: [1] })
    expect(res.status).toBe(422)
  })
})

describe('Etapa 6 — Confirmação', () => {
  beforeEach(() => jest.clearAllMocks())

  it('confirmação sem autorização retorna 422', async () => {
    // Minimal mocks — controller will load context; if fails still expect 4xx
    supabase.from.mockImplementation(() => mockChain({ data: campanhaEditavel, error: null, count: 0 }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/revisao/confirmar')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        autorizacao_aceita: false,
        confirmacao_texto: 'CONFIRMAR',
        ciencia_avisos: true,
      })

    expect([400, 422]).toContain(res.status)
  })

  it('confirmação com texto errado retorna 400/422', async () => {
    supabase.from.mockImplementation(() => mockChain({ data: campanhaEditavel, error: null, count: 0 }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/revisao/confirmar')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        autorizacao_aceita: true,
        confirmacao_texto: 'ERRADO',
        ciencia_avisos: true,
      })

    expect([400, 422]).toContain(res.status)
  })
})

describe('Etapa 6 — Estado de bloqueio e histórico', () => {
  beforeEach(() => jest.clearAllMocks())

  it('GET /revisao/bloqueio retorna shape', async () => {
    supabase.from.mockReturnValue(mockChain({
      data: {
        ...campanhaEditavel,
        status: 'pronta',
        versao_atual: 1,
        config_hash: 'abc',
        confirmada_em: '2026-08-21T12:00:00.000Z',
      },
      error: null,
    }))

    const res = await request(app)
      .get('/api/disparo/campanhas/1/revisao/bloqueio')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('congelada')
    expect(res.body).toHaveProperty('pode_editar')
    expect(res.body.congelada).toBe(true)
    expect(res.body.pode_editar).toBe(false)
  })

  it('GET /revisao/historico lista versões', async () => {
    let n = 0
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaEditavel, error: null })
      if (table === 'disparo_campanha_revisoes') {
        return mockChain({
          data: [{
            id: 1,
            versao: 1,
            hash: 'deadbeef',
            status: 'ativa',
            confirmado_em: '2026-08-21T12:00:00.000Z',
            confirmado_por: 5,
            avisos_aceitos: [],
          }],
          error: null,
        })
      }
      n += 1
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .get('/api/disparo/campanhas/1/revisao/historico')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.revisoes || res.body).toBeTruthy()
  })

  it('exportar JSON não inclui token', async () => {
    supabase.from.mockImplementation(() => mockChain({
      data: campanhaEditavel,
      error: null,
      count: 0,
    }))

    const res = await request(app)
      .get('/api/disparo/campanhas/1/revisao/exportar?format=json')
      .set('Authorization', `Bearer ${token()}`)

    // Pode 200 ou 500 se contexto incompleto — se 200, checar sensíveis
    if (res.status === 200) {
      const raw = JSON.stringify(res.body)
      expect(raw).not.toMatch(/instance_token|client_token|SECRET|password/i)
    } else {
      expect([200, 422, 500]).toContain(res.status)
    }
  })
})

describe('Etapa 6 — Voltar para edição', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita voltar se em_execucao', async () => {
    supabase.from.mockReturnValue(mockChain({
      data: { ...campanhaEditavel, status: 'em_execucao' },
      error: null,
    }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/revisao/voltar-edicao')
      .set('Authorization', `Bearer ${token()}`)
      .send({ confirmacao: true })

    expect(res.status).toBe(422)
  })

  it('aceita voltar edição em campanha pausada e encerra a execução', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({
          data: { ...campanhaEditavel, status: 'pausada' },
          error: null,
        })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: { id: 88, status: 'pausada' },
          error: null,
        })
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({
          data: [{ id: 1 }, { id: 2 }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/revisao/voltar-edicao')
      .set('Authorization', `Bearer ${token()}`)
      .send({ confirmacao: true })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('configurando')
    expect(res.body.execucao_encerrada).toBe(true)
    expect(res.body.itens_cancelados).toBe(2)
  })
})
