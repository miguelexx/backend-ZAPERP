/**
 * Mensagens interativas Whapi: envio (POST /messages/interactive) + normalização da RESPOSTA
 * inbound (toque em botão/lista → inbound de texto para a URA). fetch mockado. Ver doc 25 §26.3.
 */

describe('Whapi interativas — envio', () => {
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
      ok: true, status: 200, text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.INT' } }),
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

  test('botões → POST /messages/interactive { to, type, body:{text}, action }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendInteractive('5534988887777', {
      type: 'button',
      body: 'Escolha uma opção',
      action: { buttons: [{ type: 'quick_reply', title: 'Sim', id: 's' }, { type: 'quick_reply', title: 'Não', id: 'n' }] },
    }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.INT')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/interactive')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    const body = JSON.parse(opts.body)
    expect(body.to).toBe('5534988887777')
    expect(body.type).toBe('button')
    expect(body.body).toEqual({ text: 'Escolha uma opção' })
    expect(body.action.buttons).toHaveLength(2)
  })

  test('lista aceita header/footer como string → { text }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    await whapi.sendInteractive('5534988887777', {
      type: 'list', header: 'Menu', body: 'Selecione', footer: 'Atendimento',
      action: { label: 'Abrir', list: { sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Op1' }] }] } },
    }, OPTS)
    const body = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
    expect(body.header).toEqual({ text: 'Menu' })
    expect(body.footer).toEqual({ text: 'Atendimento' })
    expect(body.action.list.sections).toHaveLength(1)
    expect(body.action.list.label).toBe('Abrir')
    expect(body.action).not.toHaveProperty('label')
  })

  test('lista da triagem chega ao HTTP com label e opções no contrato Whapi', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const { buildInteractivePayload } = require('../services/whapiTriage/whapiTriageRenderer')
    const payload = buildInteractivePayload({ mode: 'list', body_text: 'Escolha', button_label: 'Setores', options: [
      { id: 'suporte', label: 'Suporte', departamento_id: 7, active: true },
    ] })
    const result = await require('../services/providers/whapi').sendInteractive('5534988887777', payload, OPTS)
    expect(result.ok).toBe(true)
    const body = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
    expect(body.action.list).toEqual({ label: 'Setores', sections: [{ title: 'Setores', rows: [{ id: 'suporte', title: 'Suporte' }] }] })
    expect(body.action).not.toHaveProperty('label')
  })

  test('lista sem label é rejeitada antes da requisição', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const result = await require('../services/providers/whapi').sendInteractive('5534988887777', {
      type: 'list', body: 'Escolha', action: { list: { sections: [] } },
    }, OPTS)
    expect(result.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('valida type/body/action sem chamar a API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.sendInteractive('553', { type: 'x', body: 'a', action: { buttons: [{ id: 'a', title: 'A' }] } }, OPTS)).ok).toBe(false)
    expect((await whapi.sendInteractive('553', { type: 'button', action: { buttons: [{ id: 'a', title: 'A' }] } }, OPTS)).ok).toBe(false)
    expect((await whapi.sendInteractive('553', { type: 'button', body: 'a' }, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('action tem que bater com o type (button sem buttons[] → erro, sem API)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r1 = await whapi.sendInteractive('553', { type: 'button', body: 'a', action: { list: {} } }, OPTS)
    expect(r1.ok).toBe(false)
    expect(String(r1.error)).toContain("type='button'")
    const r2 = await whapi.sendInteractive('553', { type: 'list', body: 'a', action: { buttons: [] } }, OPTS)
    expect(r2.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('corpo vazio {text:""} ou só espaços → rejeitado sem API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.sendInteractive('553', { type: 'button', body: { text: '' }, action: { buttons: [{ id: 'a', title: 'A' }] } }, OPTS)).ok).toBe(false)
    expect((await whapi.sendInteractive('553', { type: 'button', body: '   ', action: { buttons: [{ id: 'a', title: 'A' }] } }, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})

describe('Whapi interativas — resposta inbound (normalização)', () => {
  let controller
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi: jest.fn(), statusZapi: jest.fn() }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  test('extractInteractiveReply: buttons_reply', () => {
    const r = controller._test.extractInteractiveReply({ reply: { type: 'buttons_reply', buttons_reply: { id: 'b1', title: 'Falar com humano' } } })
    expect(r).toEqual({ id: 'b1', title: 'Falar com humano', description: null })
  })

  test('extractInteractiveReply: list_reply em m.interactive', () => {
    const r = controller._test.extractInteractiveReply({ interactive: { type: 'list_reply', list_reply: { id: 'l2', title: 'Financeiro', description: 'Boletos' } } })
    expect(r).toEqual({ id: 'l2', title: 'Financeiro', description: 'Boletos' })
  })

  test('resposta de botão vira inbound de texto (chat) com título e id', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.r', from_me: false, type: 'reply', chat_id: '5534988887777@s.whatsapp.net',
        reply: { type: 'buttons_reply', buttons_reply: { id: 'menu_suporte', title: 'Suporte' } }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.type).toBe('chat')
    expect(m.body).toBe('Suporte')
    expect(m.text.message).toBe('Suporte')
    expect(m.interactiveReplyId).toBe('menu_suporte')
    expect(m.interactiveReplyTitle).toBe('Suporte')
    expect(m.fromMe).toBe(false)
  })

  test('handleWebhookWhapi despacha resposta de botão ao pipeline como chat', async () => {
    const receberZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi, statusZapi: jest.fn() }))
    const ctrl = require('../controllers/webhookWhapiController')
    let snap = null
    receberZapi.mockImplementation(async (rq, rs) => { snap = { type: rq.body.type, body: rq.body.body, replyId: rq.body.interactiveReplyId }; return rs.status(200).json({ ok: true }) })
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: {
        channel_id: 'NEBULA-AER3B',
        messages: [{ id: 'wamid.r', from_me: false, type: 'reply', chat_id: '5534988887777@s.whatsapp.net',
          reply: { type: 'list_reply', list_reply: { id: 'fin', title: 'Financeiro' } }, timestamp: 1 }],
      },
    }
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json() { return this } }
    await ctrl.handleWebhookWhapi(req, res)
    expect(receberZapi).toHaveBeenCalledTimes(1)
    expect(snap).toEqual({ type: 'ReceivedCallback', body: 'Financeiro', replyId: 'fin' })
  })

  test('mensagem normal não ganha campos interativos', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.t', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'oi' }, timestamp: 1 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.type).toBe('chat')
    expect(m.body).toBe('oi')
    expect(m.interactiveReplyId).toBeUndefined()
  })
})
