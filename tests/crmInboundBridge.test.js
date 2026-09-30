'use strict'

/**
 * Testes da ponte WhatsApp ↔ inbox do CRM Avançado (ambos os sentidos):
 *   - crmSyncService.forwardInboundMessage: gate por CRM_INBOUND_URL + segredo, header,
 *     corpo, timeout/retry de rede e fire-and-forget (nunca rejeita).
 *   - crmInboxInbound.mapTipo: mapeamento do `tipo` interno → enum do CRM.
 */

const crmSync = require('../services/crmSyncService')
const { mapTipo } = require('../controllers/webhookInbound/crmInboxInbound')

const OLD_ENV = process.env

beforeEach(() => {
  jest.resetAllMocks()
  process.env = { ...OLD_ENV }
  process.env.CRM_INBOUND_URL = 'https://crm-api.exemplo.com/api/webhooks/zaperp/mensagem'
  process.env.ZAP_SSO_SECRET = 'segredo-teste'
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => '',
  })
})

afterAll(() => {
  process.env = OLD_ENV
})

describe('forwardInboundMessage — gate de configuração', () => {
  test('sem CRM_INBOUND_URL → no-op silencioso (não chama fetch, resolve null)', async () => {
    delete process.env.CRM_INBOUND_URL
    const r = await crmSync.forwardInboundMessage({ companyId: 1, telefone: '5511999999999', mensagem: 'oi' })
    expect(r).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('sem ZAP_SSO_SECRET → não chama fetch', async () => {
    delete process.env.ZAP_SSO_SECRET
    await crmSync.forwardInboundMessage({ companyId: 1, telefone: '5511999999999', mensagem: 'oi' })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('forwardInboundMessage — POST', () => {
  test('bate na URL COMPLETA de inbound, com header do segredo e fromMe:false', async () => {
    await crmSync.forwardInboundMessage({
      companyId: 7,
      telefone: '5511988887777',
      nome: 'Cliente Teste',
      mensagem: 'olá',
      tipo: 'texto',
      midiaUrl: null,
      messageId: '4321',
    })
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://crm-api.exemplo.com/api/webhooks/zaperp/mensagem')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-zaperp-secret']).toBe('segredo-teste')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(opts.body)
    expect(body).toMatchObject({
      companyId: 7,
      telefone: '5511988887777',
      nome: 'Cliente Teste',
      mensagem: 'olá',
      tipo: 'texto',
      messageId: '4321',
      fromMe: false,
    })
  })

  test('fromMe é SEMPRE false, mesmo se o caller passar true', async () => {
    await crmSync.forwardInboundMessage({ companyId: 1, telefone: '55119', mensagem: 'x', fromMe: true })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.fromMe).toBe(false)
  })
})

describe('forwardInboundMessage — resiliência', () => {
  test('falha de rede → 1 retry (2 tentativas no total) e resolve _crmError sem lançar', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await crmSync.forwardInboundMessage({ companyId: 1, telefone: '55119', mensagem: 'x' })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(crmSync.isCrmError(r)).toBe(true)
    expect(r.status).toBe(0)
  })

  test('resposta HTTP não-OK (5xx) → NÃO retenta (resposta chegou) e resolve _crmError', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'erro interno',
    })
    const r = await crmSync.forwardInboundMessage({ companyId: 1, telefone: '55119', mensagem: 'x' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(crmSync.isCrmError(r)).toBe(true)
    expect(r.status).toBe(500)
  })
})

describe('mapTipo — tipo interno → enum do CRM', () => {
  const casos = [
    ['imagem', 'imagem'],
    ['sticker', 'imagem'],
    ['audio', 'audio'],
    ['voice', 'audio'],
    ['video', 'video'],
    ['arquivo', 'documento'],
    ['location', 'localizacao'],
    ['texto', 'texto'],
    ['contact', 'texto'],
    ['poll', 'texto'],
    ['reaction', 'texto'],
    [null, 'texto'],
    [undefined, 'texto'],
  ]
  casos.forEach(([entrada, esperado]) => {
    test(`"${entrada}" → "${esperado}"`, () => {
      expect(mapTipo(entrada)).toBe(esperado)
    })
  })
})
