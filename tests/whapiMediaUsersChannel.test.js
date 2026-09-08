/**
 * Telas da doc Whapi: Media, Users (conta/QR) e Channel.
 * fetch mockado — sem token/canal real. Paths confirmados no OpenAPI. Ver doc 25.
 */

describe('Whapi — Media / Users / Channel (doc)', () => {
  let prevBase
  beforeEach(() => {
    jest.resetModules()
    prevBase = process.env.WHAPI_BASE_URL
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    if (prevBase === undefined) delete process.env.WHAPI_BASE_URL
    else process.env.WHAPI_BASE_URL = prevBase
    jest.resetModules()
  })

  function mockDeps({ fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl)
    const beforeWhatsAppSend = jest.fn(async () => ({ allow: true }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend,
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: { id, company_id: companyId, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry, beforeWhatsAppSend }
  }

  const jsonRes = (obj, { ok = true, status = 200 } = {}) => ({
    ok, status, text: async () => JSON.stringify(obj),
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
  })
  const CTX = { companyId: 1, whatsappInstanceId: 10 }
  const load = () => require('../services/providers/whapi')
  const callOf = (m, i = 0) => ({
    url: m.mock.calls[i][0],
    opts: m.mock.calls[i][1],
    body: m.mock.calls[i][1].body ? JSON.parse(m.mock.calls[i][1].body) : null,
  })

  test('adapter exporta os métodos das telas Media / Users / Channel', () => {
    mockDeps({ fetchImpl: async () => jsonRes({}) })
    const whapi = load()
    const required = [
      'uploadMedia', 'getMediaFiles', 'getMedia', 'deleteMedia',
      'getLoginQr', 'getLoginQrBase64', 'getLoginQrRowData', 'getLoginCode', 'logoutUser',
      'getUserProfile', 'getContactProfile', 'updateUserProfile',
      'getAccountRegistrationDate', 'getUsername', 'setUsername',
      'getConnectionStatus', 'getChannelSettings', 'resetChannelSettings',
      'updateChannelSettings', 'getAllowedEvents', 'testWebhook', 'getLimits',
    ]
    for (const name of required) {
      expect(typeof whapi[name]).toBe('function')
    }
  })

  test('getMediaFiles GET /media?count=', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ files: [{ id: 'file-1' }], total: 1, count: 1, offset: 0 }),
    })
    const r = await load().getMediaFiles({ ...CTX, count: 20 })
    expect(r.ok).toBe(true)
    expect(r.files).toHaveLength(1)
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/media?count=20')
    expect(callOf(fetchWithRetry).opts.method).toBe('GET')
  })

  test('getMedia GET /media/{id} JSON com link', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ link: 'https://cdn.example/a.jpg' }),
    })
    const r = await load().getMedia('file-abc-1', CTX)
    expect(r.ok).toBe(true)
    expect(r.link).toBe('https://cdn.example/a.jpg')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/media/file-abc-1')
  })

  test('deleteMedia DELETE /media/{id} sem send-guard', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => jsonRes({ success: true }),
    })
    const r = await load().deleteMedia('file-abc-1', CTX)
    expect(r.ok).toBe(true)
    expect(callOf(fetchWithRetry).opts.method).toBe('DELETE')
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
  })

  test('getLoginQrBase64 GET /users/login', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ base64: 'aaa' }),
    })
    const r = await load().getLoginQrBase64(CTX)
    expect(r.ok).toBe(true)
    expect(r.image).toMatch(/^data:image\/png;base64,/)
    expect(callOf(fetchWithRetry).url).toContain('https://gate.whapi.test/users/login?')
    expect(callOf(fetchWithRetry).url).toContain('wakeup=true')
  })

  test('getLoginQrRowData GET /users/login/rowdata', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ ref: 'xyz', key: 'k' }),
    })
    const r = await load().getLoginQrRowData(CTX)
    expect(r.ok).toBe(true)
    expect(r.rowdata.ref).toBe('xyz')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/users/login/rowdata?wakeup=true')
  })

  test('getUserProfile GET /users/profile', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ name: 'Loja', about: 'oi', icon: 'https://x/i.jpg' }),
    })
    const r = await load().getUserProfile(CTX)
    expect(r.ok).toBe(true)
    expect(r.profile.name).toBe('Loja')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/users/profile')
  })

  test('getContactProfile GET /contacts/{id}/profile', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ icon_full: 'https://x/full.jpg', about: 'bio' }),
    })
    const r = await load().getContactProfile('5534988887777', CTX)
    expect(r.ok).toBe(true)
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/contacts/5534988887777/profile')
  })

  test('getAccountRegistrationDate GET /users/account/registration_date', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ creation: 1, last_registration: 2 }),
    })
    const r = await load().getAccountRegistrationDate(CTX)
    expect(r.ok).toBe(true)
    expect(r.creation).toBe(1)
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/users/account/registration_date')
  })

  test('getUsername GET /users/username e setUsername PATCH', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ username: 'loja', state: 'ACTIVE', pin: null, success: true }),
    })
    const whapi = load()
    const got = await whapi.getUsername(CTX)
    expect(got.ok).toBe(true)
    expect(callOf(fetchWithRetry, 0).url).toBe('https://gate.whapi.test/users/username')
    const set = await whapi.setUsername('loja', { ...CTX, reserve: true })
    expect(set.ok).toBe(true)
    const c = callOf(fetchWithRetry, 1)
    expect(c.opts.method).toBe('PATCH')
    expect(c.body).toEqual({ username: 'loja', reserve: true })
  })

  test('getChannelSettings GET /settings', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ offline_mode: false, webhooks: [] }),
    })
    const r = await load().getChannelSettings(CTX)
    expect(r.ok).toBe(true)
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/settings')
  })

  test('resetChannelSettings exige confirm e DELETE /settings', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    const denied = await whapi.resetChannelSettings(CTX)
    expect(denied.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    const ok = await whapi.resetChannelSettings({ ...CTX, confirm: true })
    expect(ok.ok).toBe(true)
    expect(callOf(fetchWithRetry).opts.method).toBe('DELETE')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/settings')
  })

  test('updateChannelSettings PATCH /settings só envia chaves conhecidas', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().updateChannelSettings({
      auto_read_messages: true,
      lixo: 1,
      media: { auto_download: ['image'] },
    }, CTX)
    expect(r.ok).toBe(true)
    expect(callOf(fetchWithRetry).opts.method).toBe('PATCH')
    expect(callOf(fetchWithRetry).body).toEqual({
      auto_read_messages: true,
      media: { auto_download: ['image'] },
    })
  })

  test('getAllowedEvents GET /settings/events', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes([{ type: 'messages', method: 'post' }]),
    })
    const r = await load().getAllowedEvents(CTX)
    expect(r.ok).toBe(true)
    expect(r.events[0].type).toBe('messages')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/settings/events')
  })

  test('testWebhook POST /settings/webhook_test', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().testWebhook({
      type: 'messages',
      url: 'https://app.example/webhooks/whapi',
      mode: 'body',
    }, CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/settings/webhook_test')
    expect(c.opts.method).toBe('POST')
    expect(c.body).toEqual({
      type: 'messages',
      url: 'https://app.example/webhooks/whapi',
      mode: 'body',
    })
  })

  test('getLimits GET /limits trata 204 como ilimitado', async () => {
    mockDeps({
      fetchImpl: async () => ({
        ok: true, status: 204, text: async () => '',
        headers: { get: () => '' },
        arrayBuffer: async () => Buffer.alloc(0),
      }),
    })
    const r = await load().getLimits(CTX)
    expect(r.ok).toBe(true)
    expect(r.unlimited).toBe(true)
  })
})
