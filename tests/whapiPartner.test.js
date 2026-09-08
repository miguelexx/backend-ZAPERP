/**
 * Partner API Whapi — cria canal no manager.whapi.cloud.
 * fetch mockado; sem token real. Ver docs/ai-handoff/25.
 */

describe('Whapi Partner — provisionamento de canal', () => {
  const PREV = {}

  beforeEach(() => {
    jest.resetModules()
    for (const key of ['WHAPI_PARTNER_TOKEN', 'WHAPI_PARTNER_PROJECT_ID', 'WHAPI_MANAGER_URL']) {
      PREV[key] = process.env[key]
    }
    process.env.WHAPI_PARTNER_TOKEN = 'partner-test-token'
    process.env.WHAPI_PARTNER_PROJECT_ID = 'projTest1234567890ab'
    process.env.WHAPI_MANAGER_URL = 'https://manager.whapi.test'
  })

  afterEach(() => {
    for (const key of ['WHAPI_PARTNER_TOKEN', 'WHAPI_PARTNER_PROJECT_ID', 'WHAPI_MANAGER_URL']) {
      if (PREV[key] === undefined) delete process.env[key]
      else process.env[key] = PREV[key]
    }
    jest.resetModules()
  })

  function mockFetch(fetchImpl) {
    const fetchWithRetry = jest.fn(fetchImpl)
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    return { fetchWithRetry }
  }

  const jsonRes = (obj, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    text: async () => JSON.stringify(obj),
  })

  test('isPartnerConfigured reflete o token de ambiente', () => {
    mockFetch(async () => jsonRes({}))
    delete process.env.WHAPI_PARTNER_TOKEN
    const partner = require('../services/providers/whapi/partner')
    expect(partner.isPartnerConfigured()).toBe(false)
  })

  test('createChannel PUT /channels com Bearer partner e devolve id+token', async () => {
    const { fetchWithRetry } = mockFetch(async () => jsonRes({
      id: 'NEBULA-AER3B',
      token: 'channelTokenFromPartner',
      name: 'ZapERP empresa 30',
      projectId: 'projTest1234567890ab',
      apiUrl: 'https://gate.whapi.cloud/',
    }))
    const partner = require('../services/providers/whapi/partner')
    const channel = await partner.createChannel({ companyId: 30, name: 'ZapERP empresa 30' })
    expect(channel.id).toBe('NEBULA-AER3B')
    expect(channel.token).toBe('channelTokenFromPartner')
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://manager.whapi.test/channels')
    expect(opts.method).toBe('PUT')
    expect(opts.headers.authorization).toBe('Bearer partner-test-token')
    expect(JSON.parse(opts.body)).toEqual({
      name: 'ZapERP empresa 30',
      projectId: 'projTest1234567890ab',
    })
    expect(String(url)).not.toMatch(/token=/)
  })

  test('sem projectId no env busca GET /projects e usa isDefault', async () => {
    delete process.env.WHAPI_PARTNER_PROJECT_ID
    const { fetchWithRetry } = mockFetch(async (url) => {
      if (String(url).includes('/projects')) {
        return jsonRes({
          projects: [
            { id: 'otherProject000000001', name: 'Outro', isDefault: false },
            { id: 'defaultProject00000002', name: 'Principal', isDefault: true },
          ],
        })
      }
      return jsonRes({
        id: 'SHAZAM-3HDYQ',
        token: 'tokFromDefaultProject',
        name: 'Canal',
        projectId: 'defaultProject00000002',
      })
    })
    const partner = require('../services/providers/whapi/partner')
    const channel = await partner.createChannel({ companyId: 1 })
    expect(channel.id).toBe('SHAZAM-3HDYQ')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://manager.whapi.test/projects?count=20')
    expect(JSON.parse(fetchWithRetry.mock.calls[1][1].body).projectId).toBe('defaultProject00000002')
  })
})
