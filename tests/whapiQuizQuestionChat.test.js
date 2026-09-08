/**
 * Whapi: sendQuiz (POST /messages/quiz), sendQuestion (POST /messages/question),
 * getChat (GET /chats/{ChatID}). fetch mockado. Ver doc 25 §32.
 */

describe('Whapi quiz / question / getChat', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.X' } }),
    })))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
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

  test('sendQuiz POST /messages/quiz { to, title, options, correct_option_index }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendQuiz('5534988887777', { title: 'Capital do BR?', options: ['Brasília', 'Rio', 'SP'], correctOptionIndex: 0 }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.X')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/quiz')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', title: 'Capital do BR?', options: ['Brasília', 'Rio', 'SP'], correct_option_index: 0 })
  })

  test('sendQuiz rejeita índice fora do range e <2 opções sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.sendQuiz('553', { title: 'T', options: ['A', 'B'], correctOptionIndex: 5 }, OPTS)).ok).toBe(false)
    expect((await whapi.sendQuiz('553', { title: 'T', options: ['A'], correctOptionIndex: 0 }, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('sendQuestion POST /messages/question { to, body }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendQuestion('5534988887777', 'Como avalia nosso atendimento?', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/question')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', body: 'Como avalia nosso atendimento?' })
  })

  test('sendQuestion rejeita body vazio sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.sendQuestion('553', '   ', OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('getChat GET /chats/{ChatID} (telefone → ChatID) devolve metadados', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: '5534988887777@s.whatsapp.net', name: 'Otávio', type: 'contact', unread: 2 }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getChat('5534988887777', OPTS)
    expect(r.ok).toBe(true)
    expect(r.chat.name).toBe('Otávio')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/chats/5534988887777%40s.whatsapp.net')
  })

  test('getChat 404 → ok:false httpStatus 404', async () => {
    mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'not found' } }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getChat('5534988887777', OPTS)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(404)
  })
})
