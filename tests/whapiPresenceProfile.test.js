/**
 * Whapi: presença do contato (getPresence GET /presences/{id}, subscribePresence POST),
 * perfil Business (getBusinessProfile GET /business, editBusinessProfile POST /business),
 * e normalização do evento presences[] no webhook. fetch mockado. Ver doc 25 §32.
 */

describe('Whapi presence + business profile (adapter)', () => {
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
  const jsonRes = (status, obj) => async () => ({ ok: status < 400, status, text: async () => (obj == null ? '' : JSON.stringify(obj)) })

  test('subscribePresence POST /presences/{id} (telefone → ChatID)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, {}) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.subscribePresence('5534988887777', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/presences/5534988887777%40s.whatsapp.net')
    expect(opts.method).toBe('POST')
  })

  test('getPresence GET /presences/{id} mapeia status + last_seen', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { status: 'online', last_seen: 1893456000 }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getPresence('5534988887777', OPTS)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('online')
    expect(r.lastSeen).toBe(1893456000)
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/presences/5534988887777%40s.whatsapp.net')
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('GET')
  })

  test('getBusinessProfile GET /business', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { address: 'Rua X', email: 'a@b.com' }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getBusinessProfile(OPTS)
    expect(r.ok).toBe(true)
    expect(r.profile.address).toBe('Rua X')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business')
  })

  test('editBusinessProfile POST /business só envia campos conhecidos; valida limites', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.editBusinessProfile({ address: 'Rua Nova', foo: 'ignorado', websites: ['https://x.com'] }, OPTS)
    expect(r.ok).toBe(true)
    const body = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
    expect(body).toEqual({ address: 'Rua Nova', websites: ['https://x.com'] })
  })

  test('editBusinessProfile rejeita >2 websites e campo vazio sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.editBusinessProfile({ websites: ['a', 'b', 'c'] }, OPTS)).ok).toBe(false)
    expect((await whapi.editBusinessProfile({}, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})

describe('Whapi presence — normalização do webhook', () => {
  let controller
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi: jest.fn(), statusZapi: jest.fn() }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  test('normalizeWhapiPresence extrai chat_id, status, last_seen e telefone', () => {
    const p = controller._test.normalizeWhapiPresence(
      { contact_id: '5534988887777@s.whatsapp.net', status: 'online', last_seen: 1893456000 },
      { channelId: 'NEBULA-AER3B' },
    )
    expect(p).toEqual({
      channel_id: 'NEBULA-AER3B',
      chat_id: '5534988887777@s.whatsapp.net',
      telefone: '5534988887777',
      status: 'online',
      last_seen: 1893456000,
    })
  })

  test('presence sem entry → null', () => {
    expect(controller._test.normalizeWhapiPresence({ status: 'offline' }, {})).toBeNull()
  })
})
