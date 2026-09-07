/**
 * Endpoints extras Whapi (2026-09-07): pin/star/played, patchChat/pin/mute,
 * getContactAbout/addContact/getIdByLid/getLidById, getLoginCode, sendLink(link_preview).
 * fetch mockado. Paths confirmados no OpenAPI Whapi. Ver docs/ai-handoff/25.
 */

describe('Whapi — endpoints extras', () => {
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

  const jsonRes = (obj, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(obj) })
  const CTX = { companyId: 1, whatsappInstanceId: 10 }
  const load = () => require('../services/providers/whapi')
  const callOf = (m, i = 0) => ({ url: m.mock.calls[i][0], opts: m.mock.calls[i][1], body: m.mock.calls[i][1].body ? JSON.parse(m.mock.calls[i][1].body) : null })

  test('pinMessage POST /messages/{id}/pin { time } default day', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const ok = await load().pinMessage('wamid.1', CTX)
    expect(ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/wamid.1/pin')
    expect(c.opts.method).toBe('POST')
    expect(c.body).toEqual({ time: 'day' })
  })

  test('starMessage PUT /messages/{id}/star { starred }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    expect(await load().starMessage('wamid.1', true, CTX)).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/wamid.1/star')
    expect(c.opts.method).toBe('PUT')
    expect(c.body).toEqual({ starred: true })
  })

  test('markMessageAsPlayed PUT /messages/{id}/played sem corpo', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    expect(await load().markMessageAsPlayed('wamid.1', CTX)).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/wamid.1/played')
    expect(c.opts.method).toBe('PUT')
    expect(c.opts.body).toBeUndefined()
  })

  test('patchChat PATCH /chats/{id} só envia campos válidos', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    expect(await load().patchChat('5534988887777', { pin: true, ephemeral: 'week', lixo: 1 }, CTX)).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/chats/5534988887777%40s.whatsapp.net')
    expect(c.opts.method).toBe('PATCH')
    expect(c.body).toEqual({ pin: true, ephemeral: 'week' })
  })

  test('pinChat e muteChat mapeiam para patchChat', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    await whapi.pinChat('5534988887777', true, CTX)
    expect(callOf(fetchWithRetry, 0).body).toEqual({ pin: true })
    await whapi.muteChat('5534988887777', false, CTX)
    expect(callOf(fetchWithRetry, 1).body).toEqual({ mute_until: 0 })
  })

  test('patchChat sem campos válidos não chama a API', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    expect(await load().patchChat('5534988887777', { nada: 1 }, CTX)).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('getContactAbout GET /contacts/{id}/about → string', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ about: 'Disponível' }) })
    expect(await load().getContactAbout('5534988887777', CTX)).toBe('Disponível')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/contacts/5534988887777/about')
  })

  test('addContact PUT /contacts { phone, name }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: '5534988887777', name: 'Cliente' }) })
    const r = await load().addContact('5534988887777', 'Cliente', CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/contacts')
    expect(c.opts.method).toBe('PUT')
    expect(c.body).toEqual({ phone: '5534988887777', name: 'Cliente' })
  })

  test('getIdByLid GET /contacts/ids/{lid} → id', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: '5534988887777@s.whatsapp.net' }) })
    expect(await load().getIdByLid('12345@lid', CTX)).toBe('5534988887777@s.whatsapp.net')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/contacts/ids/12345%40lid')
  })

  test('getLidById GET /contacts/lids/{id} → lid', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ lid: '12345@lid' }) })
    expect(await load().getLidById('5534988887777', CTX)).toBe('12345@lid')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/contacts/lids/5534988887777')
  })

  test('getLoginCode GET /users/login/{phone} → { code }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ code: '123-456' }) })
    const r = await load().getLoginCode('55 34 98888-7777', CTX)
    expect(r.ok).toBe(true)
    expect(r.code).toBe('123-456')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/users/login/5534988887777')
  })

  test('getLoginCode canal já autenticado (409) → ok:false', async () => {
    mockDeps({ fetchImpl: async () => jsonRes({ error: 'authenticated' }, { ok: false, status: 409 }) })
    const r = await load().getLoginCode('5534988887777', CTX)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(409)
  })

  test('sendLink com título usa POST /messages/link_preview', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.LP' } }) })
    const r = await load().sendLink('5534988887777', { linkUrl: 'https://x.com', title: 'Meu link', message: 'veja' }, CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/link_preview')
    expect(c.body.to).toBe('5534988887777')
    expect(c.body.title).toBe('Meu link')
    expect(c.body.body).toContain('https://x.com')
  })

  test('sendLink sem título cai em texto simples (POST /messages/text)', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.T' } }) })
    await load().sendLink('5534988887777', { linkUrl: 'https://x.com', message: 'veja https://x.com' }, CTX)
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/messages/text')
  })
})
