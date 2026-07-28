const express = require('express')
const request = require('supertest')
const { Readable } = require('stream')

jest.mock('../helpers/allowedInboundMediaUrl', () => ({
  isAllowedInboundMediaUrl: () => true,
}))

process.env.MEDIA_PROXY_BUFFER_MAX_MB = '1'

const PAYLOAD = Buffer.alloc(2 * 1024 * 1024, 0x5a)
const fetchOriginal = global.fetch
let arrayBufferSpy
let app

beforeAll(() => {
  const { proxyMedia } = require('../controllers/mediaProxyController')
  app = express()
  app.get('/media/proxy', proxyMedia)
})

beforeEach(() => {
  arrayBufferSpy = jest.fn(async () => {
    throw new Error('arquivo grande não deve ser carregado inteiro na memória')
  })
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map([
      ['content-type', 'application/zip'],
      ['content-length', String(PAYLOAD.length)],
    ]),
    body: Readable.toWeb(Readable.from([PAYLOAD])),
    arrayBuffer: arrayBufferSpy,
  }))
})

afterAll(() => {
  global.fetch = fetchOriginal
  delete process.env.MEDIA_PROXY_BUFFER_MAX_MB
})

test('arquivo acima do limiar é transmitido por streaming, sem arrayBuffer', async () => {
  const res = await request(app)
    .get('/media/proxy')
    .query({
      url: 'https://media.exemplo.test/arquivo.zip',
      filename: 'arquivo.zip',
      disposition: 'attachment',
    })
    .buffer(true)
    .parse((response, callback) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => callback(null, Buffer.concat(chunks)))
    })

  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(PAYLOAD.length)
  expect(res.headers['content-length']).toBe(String(PAYLOAD.length))
  expect(res.headers['content-disposition']).toMatch(/^attachment;/)
  expect(arrayBufferSpy).not.toHaveBeenCalled()
})
