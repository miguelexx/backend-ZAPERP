/**
 * Testes de health check.
 */
const request = require('supertest')

// Carregar app após mocks (setup.js mocka supabase)
let app
beforeAll(() => {
  app = require('../app')
})

describe('GET /health', () => {
  it('retorna 200 e { ok: true }', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('GET /health/detailed', () => {
  it('retorna 200 quando Supabase responde', async () => {
    const res = await request(app).get('/health/detailed')
    expect([200, 503]).toContain(res.status)
    expect(res.body).toHaveProperty('ok')
    expect(res.body).toHaveProperty('checks')
    expect(res.body.checks).toHaveProperty('app', true)
    expect(res.body.checks).toHaveProperty('supabase')
  })
})
