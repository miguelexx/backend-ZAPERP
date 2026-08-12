const { _test } = require('../controllers/mediaProxyController')

describe('media proxy target resolution', () => {
  const previousAppUrl = process.env.APP_URL

  afterEach(() => {
    if (previousAppUrl == null) delete process.env.APP_URL
    else process.env.APP_URL = previousAppUrl
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
})
