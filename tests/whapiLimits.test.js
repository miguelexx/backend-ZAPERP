/**
 * Limites anti-ban Whapi (read-only): getNewChatLimit + getReachoutTimelock.
 * GET /business/limits/new_chat e /business/limits/reachout_timelock. fetch mockado. Ver doc 25 §30.
 */

describe('Whapi limits — anti-ban', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl)
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
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
  const inst = () => ({ id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true })
  const OPTS = { companyId: 1, whatsappInstanceId: 10 }
  const jsonRes = (status, obj) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) })

  test('getNewChatLimit chama GET /business/limits/new_chat com Bearer e mapeia campos', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, {
        cap_type: 'individual_new_chat_thread', is_capped: false, cap_status: 'first_warning',
        quota_limit: 50, quota_used: 30, quota_remaining: 20, cycle_end_at: 1893456000,
      }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getNewChatLimit(OPTS)
    expect(r.ok).toBe(true)
    expect(r.capped).toBe(false)
    expect(r.capStatus).toBe('first_warning')
    expect(r.quotaRemaining).toBe(20)
    expect(r.cycleEndAt).toBe(1893456000)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/limits/new_chat')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
  })

  test('getNewChatLimit: is_capped=true → capped=true', async () => {
    mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { is_capped: true, cap_status: 'capped', cycle_end_at: 100 }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getNewChatLimit(OPTS)
    expect(r.capped).toBe(true)
  })

  test('getNewChatLimit: HTTP 204 = sem cap reportado (não é erro)', async () => {
    mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(204, null) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getNewChatLimit(OPTS)
    expect(r.ok).toBe(true)
    expect(r.capped).toBe(false)
  })

  test('getReachoutTimelock chama GET /business/limits/reachout_timelock e mapeia restrição', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, { is_restricted: true, restricted_until: 1893456000, restriction_type: 'biz_quality' }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getReachoutTimelock(OPTS)
    expect(r.ok).toBe(true)
    expect(r.restricted).toBe(true)
    expect(r.restrictedUntil).toBe(1893456000)
    expect(r.restrictionType).toBe('biz_quality')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/limits/reachout_timelock')
  })

  test('getReachoutTimelock: sem restrição', async () => {
    mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { is_restricted: false, restriction_type: 'default' }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getReachoutTimelock(OPTS)
    expect(r.restricted).toBe(false)
  })

  test('instância inexistente → ok:false sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: {}, fetchImpl: jsonRes(200, {}) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getNewChatLimit(OPTS)
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})
