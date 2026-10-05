/**
 * Cache em memória + dedupe de voo do /media/proxy.
 * O player gera várias requisições da MESMA URL em segundos (duplo load do mount, Range da
 * sonda de duração, recarga dos vigias) — só a 1ª pode ir ao provedor; as demais servem da
 * memória, senão em upstream lento o vigia aborta e o áudio vira "indisponível".
 */

const assert = require('node:assert/strict')
const mediaProxyController = require('../controllers/mediaProxyController')
const { _test } = mediaProxyController

const realFetch = global.fetch

function upstreamOk(texto, { contentType = 'audio/ogg' } = {}) {
  const bytes = Buffer.from(texto)
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function makeRes() {
  const out = { statusCode: 200, headers: {}, body: null }
  const res = {
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v },
    status(c) { out.statusCode = c; return res },
    json(o) { out.body = o; return res },
    end(b) { out.body = b; return res },
  }
  return { res, out }
}

afterEach(() => {
  global.fetch = realFetch
  _test.resetMediaProxyCache()
  delete process.env.MEDIA_PROXY_CACHE_DISABLED
})

test('obterCorpoProxiado: 2ª chamada da mesma URL serve do cache (1 fetch só)', async () => {
  const fetchMock = jest.fn(async () => upstreamOk('OGGDATA'))
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')

  const a = await _test.obterCorpoProxiado(target, target.href)
  const b = await _test.obterCorpoProxiado(target, target.href)

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.fromCache, true)
  assert.equal(Buffer.compare(a.body, b.body), 0)
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('obterCorpoProxiado: chamadas CONCORRENTES compartilham um único download', async () => {
  let resolveUpstream
  const gate = new Promise((r) => { resolveUpstream = r })
  const fetchMock = jest.fn(async () => {
    await gate
    return upstreamOk('OGGDATA')
  })
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')

  const p1 = _test.obterCorpoProxiado(target, target.href)
  const p2 = _test.obterCorpoProxiado(target, target.href)
  resolveUpstream()
  const [a, b] = await Promise.all([p1, p2])

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('falha de upstream NÃO é cacheada — a tentativa seguinte volta ao provedor', async () => {
  let call = 0
  const fetchMock = jest.fn(async () => {
    call += 1
    if (call === 1) return { ok: false, status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    return upstreamOk('OGGDATA')
  })
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')

  const a = await _test.obterCorpoProxiado(target, target.href)
  const b = await _test.obterCorpoProxiado(target, target.href)

  assert.equal(a.ok, false)
  assert.equal(b.ok, true)
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('MEDIA_PROXY_CACHE_DISABLED=1 desliga o cache', async () => {
  process.env.MEDIA_PROXY_CACHE_DISABLED = '1'
  const fetchMock = jest.fn(async () => upstreamOk('OGGDATA'))
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')

  await _test.obterCorpoProxiado(target, target.href)
  await _test.obterCorpoProxiado(target, target.href)

  assert.equal(fetchMock.mock.calls.length, 2)
})

test('TTL: entrada expirada volta ao upstream (sem servir conteúdo velho para sempre)', async () => {
  const fetchMock = jest.fn(async () => upstreamOk('OGGDATA'))
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')
  const t0 = Date.now()
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0)

  await _test.obterCorpoProxiado(target, target.href)
  nowSpy.mockReturnValue(t0 + 11 * 60 * 1000) // além do TTL default (10 min)
  const depois = await _test.obterCorpoProxiado(target, target.href)

  nowSpy.mockRestore()
  assert.equal(depois.ok, true)
  assert.equal(depois.fromCache, undefined)
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('eviction LRU: estourando o teto total, a entrada mais antiga sai (memória limitada)', async () => {
  jest.resetModules()
  const prevMax = process.env.MEDIA_PROXY_CACHE_MAX_BYTES
  process.env.MEDIA_PROXY_CACHE_MAX_BYTES = String(1024 * 1024) // 1 MB
  try {
    const ctrl = require('../controllers/mediaProxyController')
    const corpo = Buffer.alloc(700 * 1024, 0x58) // 700 KB — dois não cabem em 1 MB

    ctrl._test.cachePut('k1', corpo, 'audio/ogg')
    ctrl._test.cachePut('k2', corpo, 'audio/ogg') // estoura o teto → evicta k1 (mais antigo)

    assert.equal(ctrl._test.cacheGet('k1'), null)
    assert.ok(ctrl._test.cacheGet('k2'))
    assert.equal(ctrl._test.cacheGet('k2').body.length, corpo.length)
    ctrl._test.resetMediaProxyCache()
  } finally {
    if (prevMax == null) delete process.env.MEDIA_PROXY_CACHE_MAX_BYTES
    else process.env.MEDIA_PROXY_CACHE_MAX_BYTES = prevMax
    jest.resetModules()
  }
})

test('duas mídias diferentes não se misturam no cache (corpos independentes)', async () => {
  let call = 0
  const fetchMock = jest.fn(async (url) => {
    call += 1
    return upstreamOk(String(url).includes('a.ogg') ? 'CORPO-A' : 'CORPO-B')
  })
  global.fetch = fetchMock
  const ua = new URL('https://files.ultramsg.com/a.ogg')
  const ub = new URL('https://files.ultramsg.com/b.ogg')

  const [ra, rb] = await Promise.all([
    _test.obterCorpoProxiado(ua, ua.href),
    _test.obterCorpoProxiado(ub, ub.href),
  ])
  const ra2 = await _test.obterCorpoProxiado(ua, ua.href)

  assert.equal(String(ra.body), 'CORPO-A')
  assert.equal(String(rb.body), 'CORPO-B')
  assert.equal(String(ra2.body), 'CORPO-A')
  assert.equal(ra2.fromCache, true)
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('falha com waiters concorrentes: todos recebem o erro, nada é cacheado, próxima tentativa refaz', async () => {
  let call = 0
  let resolveGate
  const gate = new Promise((r) => { resolveGate = r })
  const fetchMock = jest.fn(async () => {
    call += 1
    if (call === 1) {
      await gate
      return { ok: false, status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    return upstreamOk('OGGDATA')
  })
  global.fetch = fetchMock
  const target = new URL('https://files.ultramsg.com/audio.ogg')

  const p1 = _test.obterCorpoProxiado(target, target.href)
  const p2 = _test.obterCorpoProxiado(target, target.href)
  resolveGate()
  const [a, b] = await Promise.all([p1, p2])
  const c = await _test.obterCorpoProxiado(target, target.href)

  assert.equal(a.ok, false)
  assert.equal(b.ok, false)
  assert.equal(c.ok, true)
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('proxyMedia: Ranges CONCORRENTES no cache frio compartilham um único download', async () => {
  let resolveGate
  const gate = new Promise((r) => { resolveGate = r })
  const fetchMock = jest.fn(async () => {
    await gate
    return upstreamOk('0123456789')
  })
  global.fetch = fetchMock

  const r1 = makeRes()
  const r2 = makeRes()
  const p1 = mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: { range: 'bytes=0-3' } },
    r1.res
  )
  const p2 = mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: { range: 'bytes=-4' } },
    r2.res
  )
  resolveGate()
  await Promise.all([p1, p2])

  assert.equal(r1.out.statusCode, 206)
  assert.equal(String(r1.out.body), '0123')
  assert.equal(r2.out.statusCode, 206)
  assert.equal(String(r2.out.body), '6789')
  assert.equal(r2.out.headers['content-range'], 'bytes 6-9/10')
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('proxyMedia: Range inválido servido do cache responde 416 sem novo download', async () => {
  const fetchMock = jest.fn(async () => upstreamOk('0123456789'))
  global.fetch = fetchMock

  const warm = makeRes()
  await mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: {} },
    warm.res
  )
  const bad = makeRes()
  await mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: { range: 'bytes=50-60' } },
    bad.res
  )

  assert.equal(bad.out.statusCode, 416)
  assert.equal(bad.out.headers['content-range'], 'bytes */10')
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('proxyMedia: GET completo + Range servem com 1 download; 206 com Content-Range correto', async () => {
  const fetchMock = jest.fn(async () => upstreamOk('0123456789'))
  global.fetch = fetchMock

  const full = makeRes()
  await mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: {} },
    full.res
  )
  assert.equal(full.out.statusCode, 200)
  assert.equal(String(full.out.body), '0123456789')
  assert.equal(full.out.headers['accept-ranges'], 'bytes')

  const range = makeRes()
  await mediaProxyController.proxyMedia(
    { query: { url: 'https://files.ultramsg.com/audio.ogg' }, headers: { range: 'bytes=2-5' } },
    range.res
  )
  assert.equal(range.out.statusCode, 206)
  assert.equal(String(range.out.body), '2345')
  assert.equal(range.out.headers['content-range'], 'bytes 2-5/10')

  assert.equal(fetchMock.mock.calls.length, 1)
})
