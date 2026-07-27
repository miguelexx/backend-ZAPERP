const request = require('supertest')

describe('CORS em produção', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCorsOrigins = process.env.CORS_ORIGINS
  const previousExtraOrigins = process.env.ZAPERP_CORS_EXTRA_ORIGINS
  let app

  beforeAll(() => {
    process.env.NODE_ENV = 'production'
    process.env.CORS_ORIGINS = 'http://integracao.exemplo.local'
    process.env.ZAPERP_CORS_EXTRA_ORIGINS = 'http://localhost:5173'
    jest.resetModules()
    app = require('../app')
  })

  afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousCorsOrigins === undefined) delete process.env.CORS_ORIGINS
    else process.env.CORS_ORIGINS = previousCorsOrigins
    if (previousExtraOrigins === undefined) delete process.env.ZAPERP_CORS_EXTRA_ORIGINS
    else process.env.ZAPERP_CORS_EXTRA_ORIGINS = previousExtraOrigins
  })

  test('rejeita localhost mesmo que esteja em variável extra de reteste', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'CORS: origem não permitida' })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('aceita subdomínio corporativo por HTTPS', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'https://painel.wmsistemas.inf.br')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('https://painel.wmsistemas.inf.br')
  })

  test('rejeita subdomínio corporativo por HTTP', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://painel.wmsistemas.inf.br')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.status).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('ignora origem HTTP configurada por variável em produção', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'http://integracao.exemplo.local')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.status).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
