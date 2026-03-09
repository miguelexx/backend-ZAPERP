/**
 * Testes de autenticação e autorização.
 */
const request = require('supertest')

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

  it('GET /api/campanhas retorna 401 sem Authorization', async () => {
    const res = await request(app).get('/api/campanhas')
    expect(res.status).toBe(401)
  })
})

describe('Rota pública', () => {
  it('GET /health retorna 200 sem token', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('Webhook Z-API exige token', () => {
  it('POST /webhooks/zapi rejeita requisição sem token válido', async () => {
    const res = await request(app)
      .post('/webhooks/zapi')
      .send({ instanceId: 'test', type: 'ReceivedCallback' })
    expect([401, 500]).toContain(res.status)
    expect(res.body).toHaveProperty('error')
  })
})
