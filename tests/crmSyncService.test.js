'use strict'

/**
 * Testes do crmSyncService — sincronização ZapERP → CRM Avançado.
 * Cobre: interruptor mestre (env), IDs inteiros enviados como string, header
 * do segredo, guarda de campos obrigatórios e a garantia fire-and-forget
 * (nunca rejeita, mesmo com o CRM fora do ar ou respondendo erro).
 */

const crmSync = require('../services/crmSyncService')

const OLD_ENV = process.env

beforeEach(() => {
  jest.resetAllMocks()
  process.env = { ...OLD_ENV }
  process.env.CRM_AVANCADO_URL = 'https://crm.exemplo.com'
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

function lastCall() {
  return global.fetch.mock.calls[global.fetch.mock.calls.length - 1]
}

describe('interruptor mestre (env)', () => {
  test('sem CRM_AVANCADO_URL não chama fetch e resolve null', async () => {
    delete process.env.CRM_AVANCADO_URL
    expect(crmSync.isEnabled()).toBe(false)
    const r = await crmSync.syncEmpresa({ empresaId: 1, nome: 'ACME' })
    expect(r).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('sem ZAP_SSO_SECRET não chama fetch', async () => {
    delete process.env.ZAP_SSO_SECRET
    await crmSync.syncContato({ empresaId: 1, contatoId: 2, nome: 'Zé' })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('syncEmpresa', () => {
  test('POST na rota certa, com header do segredo e empresaId inteiro como string', async () => {
    await crmSync.syncEmpresa({ empresaId: 11, nome: 'ACME Ltda' })
    const [url, opts] = lastCall()
    expect(url).toBe('https://crm.exemplo.com/api/webhooks/zaperp/empresa')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-zaperp-secret']).toBe('segredo-teste')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ empresaId: '11', nome: 'ACME Ltda' })
    expect(typeof body.empresaId).toBe('string')
  })

  test('sem nome → não envia (campo obrigatório)', async () => {
    await crmSync.syncEmpresa({ empresaId: 11 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('barra final na URL base é normalizada', async () => {
    process.env.CRM_AVANCADO_URL = 'https://crm.exemplo.com/'
    await crmSync.syncEmpresa({ empresaId: 1, nome: 'X' })
    const [url] = lastCall()
    expect(url).toBe('https://crm.exemplo.com/api/webhooks/zaperp/empresa')
  })
})

describe('syncContato', () => {
  test('IDs inteiros viram string e campos vazios são podados', async () => {
    await crmSync.syncContato({
      empresaId: 1,
      contatoId: 42,
      nome: 'Maria',
      email: '',
      telefone: '5511999998888',
      empresaNome: undefined,
    })
    const [url, opts] = lastCall()
    expect(url).toBe('https://crm.exemplo.com/api/webhooks/zaperp/contato')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({
      empresaId: '1',
      contatoId: '42',
      nome: 'Maria',
      telefone: '5511999998888',
    })
    expect('email' in body).toBe(false)
    expect('empresaNome' in body).toBe(false)
  })

  test('sem contatoId → não envia', async () => {
    await crmSync.syncContato({ empresaId: 1, nome: 'Maria' })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('syncLead', () => {
  test('POST /lead com leadId string e origemNome', async () => {
    await crmSync.syncLead({
      empresaId: 1,
      leadId: 777,
      nome: 'Lead WhatsApp',
      telefone: '5511911112222',
      origemNome: 'WhatsApp',
    })
    const [url, opts] = lastCall()
    expect(url).toBe('https://crm.exemplo.com/api/webhooks/zaperp/lead')
    const body = JSON.parse(opts.body)
    expect(body.leadId).toBe('777')
    expect(body.empresaId).toBe('1')
    expect(body.origemNome).toBe('WhatsApp')
  })
})

describe('resumoEmpresa', () => {
  test('GET na rota certa e devolve o JSON parseado', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ empresaId: '5', crm: { totalLeads: 3, oportunidadesAbertas: 1 } }),
      text: async () => '',
    })
    const r = await crmSync.resumoEmpresa(5)
    const [url, opts] = lastCall()
    expect(url).toBe('https://crm.exemplo.com/api/webhooks/zaperp/empresa/5/resumo')
    expect(opts.method).toBe('GET')
    expect(opts.headers['x-zaperp-secret']).toBe('segredo-teste')
    expect(r.crm.totalLeads).toBe(3)
  })

  test('resposta não-ok → _crmError, sem lançar', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' })
    const r = await crmSync.resumoEmpresa(5)
    expect(crmSync.isCrmError(r)).toBe(true)
    expect(r.status).toBe(500)
  })
})

describe('fire-and-forget (nunca rejeita)', () => {
  test('fetch rejeitando (CRM fora do ar) → resolve _crmError, não lança', async () => {
    global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const r = await crmSync.syncEmpresa({ empresaId: 1, nome: 'X' })
    expect(crmSync.isCrmError(r)).toBe(true)
    expect(r.status).toBe(0)
  })

  test('resposta 4xx do CRM → resolve _crmError, não lança', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' })
    const r = await crmSync.syncContato({ empresaId: 1, contatoId: 2, nome: 'Zé' })
    expect(crmSync.isCrmError(r)).toBe(true)
    expect(r.status).toBe(401)
  })
})
