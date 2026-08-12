const { _test } = require('../controllers/mediaProxyController')
const express = require('express')
const request = require('supertest')

describe('media proxy target resolution', () => {
  const previousAppUrl = process.env.APP_URL
  const previousFetch = global.fetch

  afterEach(() => {
    if (previousAppUrl == null) delete process.env.APP_URL
    else process.env.APP_URL = previousAppUrl
    global.fetch = previousFetch
  })

  test('unwraps an accidentally nested proxy and validates the actual provider URL', () => {
    const provider = 'https://ultramsgmedia.s3.amazonaws.com/instance15/documento.pdf'
    const first = `https://zapapi.wmsistemas.inf.br/media/proxy?url=${encodeURIComponent(provider)}`
    const nested = `https://zapapi.wmsistemas.inf.br/media/proxy?url=${encodeURIComponent(first)}`

    expect(_test.unwrapNestedProxyTarget(nested).href).toBe(provider)
  })

  test('accepts only /uploads from the configured public app origin', () => {
    process.env.APP_URL = 'https://zapapi.wmsistemas.inf.br'

    expect(
      _test.isOwnPublicUploadUrl(
        new URL('https://zapapi.wmsistemas.inf.br/uploads/inbound-c15-m330132-file.pdf')
      )
    ).toBe(true)
    expect(
      _test.isOwnPublicUploadUrl(new URL('https://zapapi.wmsistemas.inf.br/config/empresa'))
    ).toBe(false)
    expect(
      _test.isOwnPublicUploadUrl(new URL('https://example.com/uploads/arquivo.pdf'))
    ).toBe(false)
  })

  test('rejects excessive proxy nesting', () => {
    let url = 'https://ultramsgmedia.s3.amazonaws.com/instance15/documento.pdf'
    for (let i = 0; i < 4; i += 1) {
      url = `https://zapapi.wmsistemas.inf.br/media/proxy?url=${encodeURIComponent(url)}`
    }

    expect(() => _test.unwrapNestedProxyTarget(url)).toThrow('too_many_proxy_layers')
  })

  test('serves real PDF bytes through a nested proxy URL with inline headers', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
    const provider = 'https://ultramsgmedia.s3.amazonaws.com/instance15/documento-sem-extensao'
    const oldProxy = `https://api-antiga.example/media/proxy?url=${encodeURIComponent(provider)}`
    global.fetch = jest.fn(async () => new Response(pdfBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    }))

    const app = express()
    app.get('/media/proxy', require('../controllers/mediaProxyController').proxyMedia)
    const response = await request(app)
      .get('/media/proxy')
      .query({ url: oldProxy, filename: 'proximo-arquivo.pdf', disposition: 'inline' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
      })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/pdf/)
    expect(response.headers['content-disposition']).toMatch(/^inline;/)
    expect(Buffer.isBuffer(response.body)).toBe(true)
    expect(response.body.subarray(0, 5).toString()).toBe('%PDF-')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe(provider)
  })

  test('keeps unapproved destinations blocked before any network request', async () => {
    global.fetch = jest.fn()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const app = express()
    app.get('/media/proxy', require('../controllers/mediaProxyController').proxyMedia)

    const response = await request(app)
      .get('/media/proxy')
      .query({ url: 'https://example.com/private/documento.pdf' })

    warn.mockRestore()
    expect(response.status).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
