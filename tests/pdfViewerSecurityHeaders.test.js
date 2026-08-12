const request = require('supertest')

let app

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  app = require('../app')
})

test('CSP permits the authenticated PDF blob inside the viewer iframe', async () => {
  const response = await request(app).get('/health').expect(200)
  const csp = String(response.headers['content-security-policy'] || '')

  expect(csp).toContain("frame-src 'self' blob:")
  expect(response.headers['x-frame-options']).toBeUndefined()
})
