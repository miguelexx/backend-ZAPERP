/**
 * Testes API — Etapa 8: opt-out, respostas, reconciliação, relatório.
 * Mock Supabase — NÃO é integração real.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../app')
const supabase = require('../config/supabase')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'disparo-etapa8-test-secret'
const COMPANY_ID = 10

function token(extra = {}) {
  return jwt.sign(
    { id: 5, company_id: COMPANY_ID, perfil: 'admin', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  )
}

function mockChain(result = { data: null, error: null, count: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit', 'range',
    'insert', 'update', 'upsert',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('Etapa 8 — Autenticação', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita GET /config/optout sem token (401)', async () => {
    const res = await request(app).get('/api/disparo/config/optout')
    expect(res.status).toBe(401)
  })

  it('rejeita GET /optouts sem token (401)', async () => {
    const res = await request(app).get('/api/disparo/optouts')
    expect(res.status).toBe(401)
  })

  it('bloqueia atendente em GET /config/optout (403)', async () => {
    const res = await request(app)
      .get('/api/disparo/config/optout')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('bloqueia supervisor em GET /campanhas/1/relatorio (403)', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/relatorio')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
    expect(res.status).toBe(403)
  })
})

describe('Etapa 8 — Isolamento company_id', () => {
  beforeEach(() => jest.clearAllMocks())

  it('lista opt-outs filtrando pelo company_id do token', async () => {
    const listQuery = mockChain({
      data: [{ id: 1, company_id: COMPANY_ID, tipo: 'optout', telefone_normalizado: '5534999887766' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const res = await request(app)
      .get('/api/disparo/optouts')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_ID })}`)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(listQuery.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })

  it('retorna 404 ao buscar campanha de outra empresa para respostas', async () => {
    const campQuery = mockChain({ data: null, error: null })
    supabase.from.mockReturnValueOnce(campQuery)

    const res = await request(app)
      .get('/api/disparo/campanhas/99/respostas')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_ID })}`)

    expect(res.status).toBe(404)
    expect(campQuery.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })

  it('obter config opt-out usa company_id do token', async () => {
    const configQuery = mockChain({ data: null, error: null })
    supabase.from.mockReturnValueOnce(configQuery)

    const res = await request(app)
      .get('/api/disparo/config/optout')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_ID })}`)

    expect(res.status).toBe(200)
    expect(res.body.company_id).toBe(COMPANY_ID)
    expect(configQuery.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })

  it('reativar opt-out exige motivo (400)', async () => {
    const res = await request(app)
      .post('/api/disparo/optouts/reativar')
      .set('Authorization', `Bearer ${token()}`)
      .send({ telefone: '5534999887766', motivo: '' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/motivo/i)
  })
})

describe('Etapa 8 — Decisão manual incerto', () => {
  beforeEach(() => jest.clearAllMocks())

  it('exige confirmacao: true', async () => {
    const campQuery = mockChain({
      data: { id: 1, company_id: COMPANY_ID, nome: 'Camp', status: 'concluida' },
      error: null,
    })
    supabase.from.mockReturnValueOnce(campQuery)

    const res = await request(app)
      .post('/api/disparo/campanhas/1/incertos/100/decisao')
      .set('Authorization', `Bearer ${token()}`)
      .send({ decisao: 'enviada', justificativa: 'Ok', confirmacao: false })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('CONFIRMACAO_OBRIGATORIA')
  })
})
