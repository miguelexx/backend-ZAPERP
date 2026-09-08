/**
 * Presença "digitando…" + Blacklist (bloquear/desbloquear) no adapter Whapi.
 * Contrato confirmado via MCP. fetch mockado, sem token/numero real. Ver doc 25.
 */

describe('Whapi — presença e blacklist', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl = null } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ success: true }),
    })))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: instancesById[`${companyId}:${id}`] || null,
        error: instancesById[`${companyId}:${id}`] ? null : 'not found',
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }

  const inst = (over = {}) => ({ id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true, ...over })
  const OPTS = { companyId: 1, whatsappInstanceId: 10 }

  test('sendPresence typing → PUT /presences/{id} { presence, delay } com Bearer', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.sendPresence('5534988887777', 'typing', { ...OPTS, delay: 3 })
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('PUT')
    expect(url).toContain('https://gate.whapi.test/presences/')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    const body = JSON.parse(opts.body)
    expect(body.presence).toBe('typing')
    expect(body.delay).toBe(3)
  })

  test('sendPresence com valor inválido não chama a API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.sendPresence('5534988887777', 'dancando', OPTS)
    expect(ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('sendPresence clampa delay em 25s', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    await whapi.sendPresence('5534988887777', 'recording', { ...OPTS, delay: 999 })
    expect(JSON.parse(fetchWithRetry.mock.calls[0][1].body).delay).toBe(25)
  })

  test('setMePresence online → PUT /presences/me', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.setMePresence('online', OPTS)
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/presences/me')
    expect(JSON.parse(opts.body)).toEqual({ presence: 'online' })
  })

  test('sem instância configurada → presença é no-op silencioso', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: {} })
    const whapi = require('../services/providers/whapi')
    expect(await whapi.sendPresence('5534988887777', 'typing', OPTS)).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('blockContact → PUT /blacklist/{id} e devolve { ok:true }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.blockContact('5534988887777', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('PUT')
    expect(url).toContain('https://gate.whapi.test/blacklist/')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
  })

  test('unblockContact → DELETE /blacklist/{id}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.unblockContact('5534988887777', OPTS)
    expect(r.ok).toBe(true)
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('DELETE')
  })

  test('blockContact HTTP 4xx → { ok:false }', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'not found' } }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.blockContact('5534988887777', OPTS)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('not found')
  })

  test('getBlacklist → GET /blacklist (array)', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ blacklist: [{ id: '5534988887777' }] }) }),
    })
    const whapi = require('../services/providers/whapi')
    const list = await whapi.getBlacklist(OPTS)
    expect(Array.isArray(list)).toBe(true)
    expect(list).toHaveLength(1)
    expect(fetchWithRetry.mock.calls[0][0]).toContain('/blacklist')
  })
})
