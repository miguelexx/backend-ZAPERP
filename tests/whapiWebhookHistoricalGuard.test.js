/**
 * Guarda anti-histórico do webhook Whapi (WHAPI_INBOUND_MAX_AGE_MINUTES).
 * No (re)connect / webhook persistente o Whapi reentrega backlog antigo com o timestamp
 * original — sem a guarda isso cria conversas "Contato" sem nome que voltam mesmo após apagar.
 */

describe('Whapi webhook — guarda anti-histórico', () => {
  let receberZapi, statusZapi, controller
  const OLD_ENV = process.env.WHAPI_INBOUND_MAX_AGE_MINUTES

  beforeEach(() => {
    jest.resetModules()
    receberZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    statusZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi, statusZapi }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => {
    jest.resetModules()
    if (OLD_ENV === undefined) delete process.env.WHAPI_INBOUND_MAX_AGE_MINUTES
    else process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = OLD_ENV
  })

  function fakeRes() {
    const r = { statusCode: 200, body: null }
    r.status = (c) => { r.statusCode = c; return r }
    r.json = (o) => { r.body = o; return r }
    return r
  }
  const nowSec = () => Math.floor(Date.now() / 1000)

  test('DESATIVADO por padrão: mensagem antiga ainda é processada (comportamento atual)', async () => {
    delete process.env.WHAPI_INBOUND_MAX_AGE_MINUTES
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.old', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'oi' }, timestamp: 1700000000 },
      ] },
    }
    await controller.handleWebhookWhapi(req, fakeRes())
    expect(receberZapi).toHaveBeenCalledTimes(1)
  })

  test('LIGADO: backlog antigo é ignorado (não chega ao pipeline)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '10'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.old', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'atendimento antigo' }, timestamp: 1700000000 },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(req.webhookLogData.counts.skipped_historical).toBe(1)
  })

  test('LIGADO: mensagem ao vivo (timestamp recente) passa normalmente', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '10'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.live', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'oi agora' }, timestamp: nowSec() },
      ] },
    }
    await controller.handleWebhookWhapi(req, fakeRes())
    expect(receberZapi).toHaveBeenCalledTimes(1)
  })

  test('LIGADO: sem timestamp confiável → tratado como ao vivo (não descarta)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '10'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.nots', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'sem ts' } },
      ] },
    }
    await controller.handleWebhookWhapi(req, fakeRes())
    expect(receberZapi).toHaveBeenCalledTimes(1)
  })

  test('helper whapiInboundIsHistorical respeita o teto', () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '10'
    const now = Date.now()
    expect(controller._test.whapiInboundIsHistorical({ timestamp: 1700000000 }, now)).toBe(true)
    expect(controller._test.whapiInboundIsHistorical({ timestamp: nowSec() }, now)).toBe(false)
    expect(controller._test.whapiInboundIsHistorical({}, now)).toBe(false)
    delete process.env.WHAPI_INBOUND_MAX_AGE_MINUTES
    expect(controller._test.whapiInboundIsHistorical({ timestamp: 1700000000 }, now)).toBe(false)
  })
})
