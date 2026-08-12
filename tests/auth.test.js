/**
 * Testes de autenticação e autorização.
 */
const request = require('supertest')
const jwt = require('jsonwebtoken')

let app
beforeAll(() => {
  app = require('../app')
})

describe('Rotas protegidas sem token', () => {
  it('GET /api/dashboard/overview retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/dashboard/overview')
    expect(res.status).toBe(401)
  })

  it('GET /api/dashboard/metrics retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/dashboard/metrics')
    expect(res.status).toBe(401)
  })

  it('GET /chats retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/chats')
    expect(res.status).toBe(401)
  })

  it('GET /api/conversas/minhas-pendencias retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/conversas/minhas-pendencias')
    expect(res.status).toBe(401)
  })

  it('GET /api/chatbot/status retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/chatbot/status')
    expect(res.status).toBe(401)
  })

  it('GET /api/chatbot/debug/logs/1 retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/chatbot/debug/logs/1')
    expect(res.status).toBe(401)
  })
})

describe('Rotas legadas de chatbot respeitam tenant do token', () => {
  const OLD_ENV = process.env

  beforeAll(() => {
    process.env = { ...OLD_ENV, JWT_SECRET: 'test-secret' }
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  const adminToken = () => jwt.sign({ id: 10, company_id: 1, perfil: 'admin' }, process.env.JWT_SECRET)

  it('GET /api/chatbot/config/:companyId bloqueia empresa diferente', async () => {
    const res = await request(app)
      .get('/api/chatbot/config/2')
      .set('Authorization', `Bearer ${adminToken()}`)

    expect(res.status).toBe(403)
  })

  it('GET /api/chatbot/debug/logs/:companyId bloqueia empresa diferente', async () => {
    const res = await request(app)
      .get('/api/chatbot/debug/logs/2')
      .set('Authorization', `Bearer ${adminToken()}`)

    expect(res.status).toBe(403)
  })
})

describe('Rota pública', () => {
  it('GET /health retorna 200 sem token', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('Webhook UltraMsg exige token', () => {
  it('POST /webhooks/ultramsg rejeita requisição sem token válido', async () => {
    const res = await request(app)
      .post('/webhooks/ultramsg')
      .send({ instanceId: 'test', event_type: 'message_received', data: {} })
    expect([401, 500]).toContain(res.status)
    expect(res.body).toHaveProperty('error')
  })
})
