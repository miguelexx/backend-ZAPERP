const request = require('supertest')

let app
beforeAll(() => {
  app = require('../app')
})

describe('frontend index cache policy', () => {
  it('forca revalidacao do HTML que referencia chunks com hash', async () => {
    const response = await request(app)
      .get('/rota-spa-teste')
      .set('Accept', 'text/html')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/text\/html/)
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.headers.expires).toBe('0')
  })
})
