/**
 * Testes API — Exclusões globais Disparo (Etapa 7).
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

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'ilike', 'order', 'range',
    'insert', 'update',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('Etapa 7 Exclusões — auth', () => {
  beforeEach(() => jest.clearAllMocks())

  it('401 sem token em GET /exclusoes', async () => {
    const res = await request(app).get('/api/disparo/exclusoes')
    expect(res.status).toBe(401)
  })

  it('403 atendente em POST /exclusoes', async () => {
    const res = await request(app)
      .post('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ telefone: '11999887766' })
    expect(res.status).toBe(403)
  })
})

describe('Etapa 7 Exclusões — listar', () => {
  beforeEach(() => jest.clearAllMocks())

  it('lista exclusões ativas filtrando por company_id do token', async () => {
    const listQuery = mockChain({
      data: [
        {
          id: 1,
          telefone_normalizado: '5511999887766',
          telefone_original: '(11) 99988-7766',
          motivo: 'Opt-out',
          ativo: true,
        },
      ],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const res = await request(app)
      .get('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.itens).toHaveLength(1)
    expect(listQuery.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
    expect(listQuery.eq).toHaveBeenCalledWith('ativo', true)
  })
})

describe('Etapa 7 Exclusões — adicionar', () => {
  beforeEach(() => jest.clearAllMocks())

  it('adiciona telefone válido', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_exclusoes') {
        const check = mockChain({ data: null, error: null })
        const insert = mockChain({
          data: {
            id: 5,
            telefone_normalizado: '5511999887766',
            telefone_original: '11999887766',
            ativo: true,
            motivo: 'Manual',
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
          insert: jest.fn(() => insert),
          single: insert.single,
          maybeSingle: check.maybeSingle,
        }
      }
      return mockChain()
    })

    const res = await request(app)
      .post('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token()}`)
      .send({ telefone: '11999887766', motivo: 'Manual' })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(res.body.exclusao.telefone_normalizado).toBe('5511999887766')
  })

  it('409 quando telefone já está ativo na lista', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: { id: 3, ativo: true }, error: null }),
    )

    const res = await request(app)
      .post('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token()}`)
      .send({ telefone: '11999887766' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/já está/i)
  })

  it('reativa exclusão soft-deleted', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_exclusoes') {
        const check = mockChain({ data: { id: 3, ativo: false }, error: null })
        const update = mockChain({
          data: { id: 3, telefone_normalizado: '5511999887766', ativo: true },
          error: null,
        })
        let phase = 'check'
        return {
          select: jest.fn(() => (phase === 'check' ? check : update)),
          eq: jest.fn(() => (phase === 'check' ? check : update)),
          update: jest.fn(() => {
            phase = 'update'
            return update
          }),
          maybeSingle: check.maybeSingle,
          single: update.single,
        }
      }
      return mockChain()
    })

    const res = await request(app)
      .post('/api/disparo/exclusoes')
      .set('Authorization', `Bearer ${token()}`)
      .send({ telefone: '11999887766' })

    expect(res.status).toBe(201)
    expect(res.body.reativado).toBe(true)
  })
})

describe('Etapa 7 Exclusões — remover (soft delete)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('remove exclusão ativa (soft delete)', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({
        data: {
          id: 7,
          telefone_normalizado: '5511999887766',
          ativo: false,
          removido_por: 5,
          removido_em: '2026-08-22T12:00:00.000Z',
        },
        error: null,
      }),
    )

    const res = await request(app)
      .delete('/api/disparo/exclusoes/7')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.exclusao.ativo).toBe(false)
  })

  it('404 quando exclusão não existe ou já removida', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: null, error: null }),
    )

    const res = await request(app)
      .delete('/api/disparo/exclusoes/999')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(404)
  })

  it('400 com id inválido', async () => {
    const res = await request(app)
      .delete('/api/disparo/exclusoes/abc')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(400)
  })
})
