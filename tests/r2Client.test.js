const assert = require('node:assert/strict')
const crypto = require('crypto')

// Credenciais fixas para tornar a assinatura determinística.
process.env.R2_ACCOUNT_ID = 'acc123'
process.env.R2_ACCESS_KEY_ID = 'AKIAEXAMPLE'
process.env.R2_SECRET_ACCESS_KEY = 'secretexample'
process.env.R2_BUCKET = 'bucket-test'

const { _test, presignGetUrl } = require('../services/storage/r2Client')

test('encodeRfc3986: mantém unreserved, codifica o resto; keepSlash preserva "/"', () => {
  assert.equal(_test.encodeRfc3986('abcXYZ-_.~', false), 'abcXYZ-_.~')
  assert.equal(_test.encodeRfc3986('a b', false), 'a%20b')
  assert.equal(_test.encodeRfc3986('a/b', false), 'a%2Fb')
  assert.equal(_test.encodeRfc3986('a/b', true), 'a/b')
  assert.equal(_test.encodeRfc3986('café', false), 'caf%C3%A9')
})

test('canonicalUriForKey: path-style /bucket/key com barras preservadas', () => {
  const uri = _test.canonicalUriForKey('bucket-test', 'media/1/2026/08/imagem/foo bar.jpg')
  assert.equal(uri, '/bucket-test/media/1/2026/08/imagem/foo%20bar.jpg')
})

test('sha256Hex de payload conhecido (âncora de correção)', () => {
  // Valor público e verificável de sha256("hello").
  assert.equal(
    _test.sha256Hex('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  )
})

test('signRequest: estrutura SigV4 correta para PUT', () => {
  const cfg = {
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secretexample',
    bucket: 'bucket-test',
    endpoint: 'https://acc123.r2.cloudflarestorage.com',
    region: 'auto',
    service: 's3',
  }
  const payload = Buffer.from('conteudo-de-teste')
  const { url, headers } = _test.signRequest({
    method: 'PUT',
    key: 'media/1/2026/08/imagem/x.jpg',
    payload,
    contentType: 'image/jpeg',
    cfg,
  })

  assert.equal(url, 'https://acc123.r2.cloudflarestorage.com/bucket-test/media/1/2026/08/imagem/x.jpg')
  // x-amz-content-sha256 deve bater com o hash do payload.
  assert.equal(headers['x-amz-content-sha256'], crypto.createHash('sha256').update(payload).digest('hex'))
  // Authorization no formato AWS4-HMAC-SHA256 com escopo e assinatura.
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
  assert.equal(headers['content-type'], 'image/jpeg')
})

test('signRequest: determinístico para as mesmas entradas', () => {
  const cfg = {
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretexample',
    bucket: 'bucket-test', endpoint: 'https://acc123.r2.cloudflarestorage.com',
    region: 'auto', service: 's3',
  }
  const RealDate = Date
  // Congela a data para eliminar a variação do x-amz-date.
  global.Date = class extends RealDate {
    constructor() { super('2026-08-13T10:00:00.000Z') }
    static now() { return new RealDate('2026-08-13T10:00:00.000Z').getTime() }
    toISOString() { return '2026-08-13T10:00:00.000Z' }
  }
  try {
    const a = _test.signRequest({ method: 'DELETE', key: 'media/1/x.jpg', payload: null, cfg })
    const b = _test.signRequest({ method: 'DELETE', key: 'media/1/x.jpg', payload: null, cfg })
    assert.equal(a.headers.Authorization, b.headers.Authorization)
    assert.match(a.headers['x-amz-date'], /^20260813T100000Z$/)
  } finally {
    global.Date = RealDate
  }
})

test('presignGetUrl: query SigV4 com assinatura e host único assinado', () => {
  const url = presignGetUrl('media/1/2026/08/imagem/x.jpg', 900)
  const u = new URL(url)
  assert.equal(u.host, 'acc123.r2.cloudflarestorage.com')
  assert.equal(u.pathname, '/bucket-test/media/1/2026/08/imagem/x.jpg')
  assert.equal(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256')
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host')
  assert.equal(u.searchParams.get('X-Amz-Expires'), '900')
  assert.match(u.searchParams.get('X-Amz-Credential'), /^AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/)
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/)
})
