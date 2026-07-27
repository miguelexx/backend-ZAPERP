/**
 * Contrato HTTP que o <audio>/<video> do navegador exige do /media/proxy.
 * Exercita o handler real (headers + fatiamento), com a origem e o fetch simulados.
 */
const express = require('express')
const request = require('supertest')

jest.mock('../helpers/allowedInboundMediaUrl', () => ({
  isAllowedInboundMediaUrl: () => true,
  fetchAllowedInboundMedia: jest.fn(),
}))

const PAYLOAD = Buffer.from('OggS'.repeat(64)) // 256 bytes
const URL_ORIGEM = 'https://media.exemplo.test/audio.ogg'

let app
const fetchOriginal = global.fetch
/** Guarda os headers enviados à origem e permite simular origem que honra (206) ou ignora (200) Range. */
let upstream

const paraArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)

beforeEach(() => {
  upstream = { honraRange: false, ultimosHeaders: null }
  global.fetch = jest.fn(async (_href, init) => {
    upstream.ultimosHeaders = init?.headers || {}
    const range = String(init?.headers?.Range || '')
    if (upstream.honraRange && range) {
      const m = range.match(/^bytes=(\d+)-(\d*)$/)
      const start = Number(m?.[1] ?? 0)
      const end = m?.[2] ? Number(m[2]) : PAYLOAD.length - 1
      const slice = PAYLOAD.subarray(start, end + 1)
      return {
        ok: true,
        status: 206,
        headers: new Map([
          ['content-type', 'audio/ogg'],
          ['content-length', String(slice.length)],
          ['content-range', `bytes ${start}-${end}/${PAYLOAD.length}`],
        ]),
        arrayBuffer: async () => paraArrayBuffer(slice),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Map([
        ['content-type', 'audio/ogg'],
        ['content-length', String(PAYLOAD.length)],
      ]),
      arrayBuffer: async () => paraArrayBuffer(PAYLOAD),
    }
  })
})

beforeAll(() => {
  const { proxyMedia } = require('../controllers/mediaProxyController')
  app = express()
  app.get('/media/proxy', proxyMedia)
})

afterAll(() => {
  global.fetch = fetchOriginal
})

const get = (headers = {}) => {
  const req = request(app).get('/media/proxy').query({ url: URL_ORIGEM })
  Object.entries(headers).forEach(([k, v]) => req.set(k, v))
  return req
}

describe('mediaProxy: resposta para players de mídia', () => {
  test('sem Range → 200 com o arquivo inteiro', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(Number(res.headers['content-length'])).toBe(PAYLOAD.length)
  })

  test('Range: bytes=0- → 206 com Content-Range (200 aqui faz o player falhar)', async () => {
    const res = await get({ Range: 'bytes=0-' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}`)
  })

  test('Range parcial → 206 com exatamente os bytes pedidos', async () => {
    const res = await get({ Range: 'bytes=10-19' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 10-19/${PAYLOAD.length}`)
    expect(Number(res.headers['content-length'])).toBe(10)
  })

  test('sem ETag fraco e com cache immutable (evita revalidar no meio da reprodução)', async () => {
    const res = await get({ Range: 'bytes=0-' })
    expect(res.headers.etag).toBeUndefined()
    expect(res.headers['cache-control']).toContain('immutable')
  })

  test('Range fora do arquivo → 416', async () => {
    const res = await get({ Range: 'bytes=9999-' })
    expect(res.status).toBe(416)
    expect(res.headers['content-range']).toBe(`bytes */${PAYLOAD.length}`)
  })
})

describe('mediaProxy: Range repassado à origem', () => {
  test('o header Range vai para a origem (evita baixar o arquivo inteiro a cada seek)', async () => {
    await get({ Range: 'bytes=10-19' })
    expect(upstream.ultimosHeaders.Range).toBe('bytes=10-19')
  })

  test('sem Range do cliente, nada de Range é enviado à origem', async () => {
    await get()
    expect(upstream.ultimosHeaders.Range).toBeUndefined()
  })

  test('origem que responde 206 tem o Content-Range repassado sem recalcular', async () => {
    upstream.honraRange = true
    const res = await get({ Range: 'bytes=10-19' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 10-19/${PAYLOAD.length}`)
    expect(Number(res.headers['content-length'])).toBe(10)
  })

  test('origem que ignora Range e devolve 200 ainda gera 206 correto', async () => {
    upstream.honraRange = false
    const res = await get({ Range: 'bytes=10-19' })
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 10-19/${PAYLOAD.length}`)
    expect(Number(res.headers['content-length'])).toBe(10)
  })

  test('origem com 206 sem Content-Range falha em vez de entregar bytes errados', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 206,
      headers: new Map([['content-type', 'audio/ogg']]),
      arrayBuffer: async () => paraArrayBuffer(PAYLOAD.subarray(10, 20)),
    }))
    const res = await get({ Range: 'bytes=10-19' })
    expect(res.status).toBe(502)
  })

  test('416 da origem é repassado (não vira 502)', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 416,
      headers: new Map([['content-range', `bytes */${PAYLOAD.length}`]]),
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const res = await get({ Range: 'bytes=9999-' })
    expect(res.status).toBe(416)
    expect(res.headers['content-range']).toBe(`bytes */${PAYLOAD.length}`)
  })
})
