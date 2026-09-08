/**
 * Endpoints da doc Whapi (Contacts / Messages / Blacklist) no adapter.
 * fetch mockado — sem token/número real. Ver docs/ai-handoff/25.
 */

describe('Whapi — endpoints da documentação (contacts/messages/blacklist)', () => {
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

  test('adapter exporta todos os métodos das telas Contacts / Messages / Blacklist', () => {
    mockDeps({ fetchImpl: async () => jsonRes({}) })
    const whapi = load()
    const required = [
      'getContacts', 'checkPhones', 'getContactMetadata', 'addContact', 'sendContact',
      'checkExist', 'getLidByIds', 'editContact', 'getLidById', 'deleteContact',
      'getContactAbout', 'getIdByLid',
      'getChatMessages', 'sendText', 'sendImage', 'sendVideo', 'sendShortVideo', 'sendGif',
      'sendAudio', 'sendVoice', 'sendFile', 'sendLink', 'sendLocation', 'sendLiveLocation',
      'blockContact', 'unblockContact', 'getBlacklist',
    ]
    for (const name of required) {
      expect(typeof whapi[name]).toBe('function')
    }
    expect(whapi.sendPtv).toBe(whapi.sendShortVideo)
  })

  test('checkExist HEAD /contacts/{id} 200 → exists:true', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => ({ ok: true, status: 200 }),
    })
    const r = await load().checkExist('5534988887777', CTX)
    expect(r).toEqual({ exists: true, httpStatus: 200 })
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('HEAD')
    expect(c.url).toBe('https://gate.whapi.test/contacts/5534988887777')
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
  })

  test('checkExist HEAD 404 → exists:false', async () => {
    mockDeps({ fetchImpl: async () => ({ ok: false, status: 404 }) })
    const r = await load().checkExist('5534988887777', CTX)
    expect(r.exists).toBe(false)
    expect(r.httpStatus).toBe(404)
  })

  test('editContact PATCH /contacts/{id} { name } sem send-guard', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => jsonRes({ contact: { id: '5534988887777', name: 'Ana' } }),
    })
    const r = await load().editContact('5534988887777', 'Ana', CTX)
    expect(r.ok).toBe(true)
    expect(r.contact.name).toBe('Ana')
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('PATCH')
    expect(c.url).toBe('https://gate.whapi.test/contacts/5534988887777')
    expect(c.body).toEqual({ name: 'Ana' })
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
  })

  test('deleteContact DELETE /contacts/{id} sem send-guard', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => jsonRes({ success: true }),
    })
    const r = await load().deleteContact('5534988887777', CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('DELETE')
    expect(c.url).toBe('https://gate.whapi.test/contacts/5534988887777')
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
  })

  test('getLidByIds GET /contacts/lids?ContactIDList=', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({
        '5534988887777': { lid: '111@lid' },
        '5511999999999': { lid: '222@lid' },
      }),
    })
    const map = await load().getLidByIds(['5534988887777', '5511999999999'], CTX)
    expect(map).toEqual({ '5534988887777': '111@lid', '5511999999999': '222@lid' })
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('GET')
    expect(c.url).toBe('https://gate.whapi.test/contacts/lids?ContactIDList=5534988887777%2C5511999999999')
  })

  test('sendGif POST /messages/gif', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.GIF' } }),
    })
    const r = await load().sendGif('5534988887777', 'https://x.test/a.mp4', 'oi', { ...CTX, returnDetails: true })
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/gif')
    expect(c.opts.method).toBe('POST')
    expect(c.body.to).toBe('5534988887777')
    expect(c.body.media).toBe('https://x.test/a.mp4')
    expect(c.body.caption).toBe('oi')
  })

  test('sendShortVideo / sendPtv POST /messages/short', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.PTV' } }),
    })
    const r = await load().sendPtv('5534988887777', 'https://x.test/b.mp4', '', { ...CTX, returnDetails: true })
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/short')
    expect(c.body.media).toBe('https://x.test/b.mp4')
  })

  test('sendLiveLocation POST /messages/live_location', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.LL' } }),
    })
    const r = await load().sendLiveLocation('5534988887777', {
      latitude: -18.91, longitude: -48.27, name: 'Praça', accuracy: 12,
    }, CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/messages/live_location')
    expect(c.body).toMatchObject({
      to: '5534988887777',
      latitude: -18.91,
      longitude: -48.27,
      name: 'Praça',
      accuracy: 12,
    })
  })
})
