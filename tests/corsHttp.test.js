const request = require('supertest')

let app

beforeAll(() => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  app = require('../app')
})

const FRONT = 'https://zaperp.wmsistemas.inf.br'

describe('CORS HTTP para o frontend de produção', () => {
  test('OPTIONS /chats/counts devolve ACAO para zaperp', async () => {
    const res = await request(app)
      .options('/chats/counts')
      .set('Origin', FRONT)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type')

    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(res.headers['access-control-allow-origin']).toBe(FRONT)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  test('GET /chats/counts 401 ainda inclui ACAO (browser não mascara como CORS)', async () => {
    const res = await request(app)
      .get('/chats/counts')
      .set('Origin', FRONT)

    expect(res.status).toBe(401)
    expect(res.headers['access-control-allow-origin']).toBe(FRONT)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  test('origem desconhecida não recebe ACAO', async () => {
    const res = await request(app)
      .get('/chats/counts')
      .set('Origin', 'https://evil.example')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
