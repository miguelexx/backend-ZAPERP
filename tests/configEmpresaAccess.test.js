const request = require('supertest')
const jwt = require('jsonwebtoken')

let app

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
  app = require('../app')
})

function token(payload = {}) {
  return jwt.sign({ id: 20, company_id: 1, perfil: 'atendente', ...payload }, process.env.JWT_SECRET)
}

describe('GET /config/empresa', () => {
  test('permite atendente autenticado carregar dados basicos da empresa', async () => {
    const res = await request(app)
      .get('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
  })

  test('mantem escrita restrita para atendente', async () => {
    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)
      .send({ nome: 'Nova marca' })

    expect(res.status).toBe(403)
  })
})
