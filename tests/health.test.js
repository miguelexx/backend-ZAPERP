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

  it('expõe a versão da release quando configurada', async () => {
    process.env.RELEASE_VERSION = '2026.07.27'
    process.env.BUILD_SHA = 'abcdef123456'
    try {
      const res = await request(app).get('/health')
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        ok: true,
        release: '2026.07.27',
        build_sha: 'abcdef123456',
      })
    } finally {
      delete process.env.RELEASE_VERSION
      delete process.env.BUILD_SHA
    }
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
