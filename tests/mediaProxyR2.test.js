const assert = require('node:assert/strict')
const { _test } = require('../controllers/mediaProxyController')

const previousAppUrl = process.env.APP_URL

beforeEach(() => {
  process.env.APP_URL = 'https://zapapi.wmsistemas.inf.br'
})

afterEach(() => {
  if (previousAppUrl == null) delete process.env.APP_URL
  else process.env.APP_URL = previousAppUrl
})

test('isOwnR2DeliveryUrl: reconhece mídia própria no R2 (/media/r2/media/...)', () => {
  const ok = new URL('https://zapapi.wmsistemas.inf.br/media/r2/media/1/2026/06/audio/x.ogg')
  assert.equal(_test.isOwnR2DeliveryUrl(ok), true)
})

test('isOwnR2DeliveryUrl: recusa outro host e outros paths', () => {
  assert.equal(_test.isOwnR2DeliveryUrl(new URL('https://outro.com/media/r2/media/1/x.ogg')), false)
  assert.equal(_test.isOwnR2DeliveryUrl(new URL('https://zapapi.wmsistemas.inf.br/uploads/x.ogg')), false)
  assert.equal(_test.isOwnR2DeliveryUrl(new URL('https://zapapi.wmsistemas.inf.br/media/proxy?url=x')), false)
})
