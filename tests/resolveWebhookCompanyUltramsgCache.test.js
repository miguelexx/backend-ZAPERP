/**
 * Cache TTL do resolvedor instanceId→instância do webhook UltraMSG (espelho do teste Whapi).
 * Sucesso cacheado 30s; erro de banco e instância não mapeada NUNCA são cacheados.
 */

const mockGetInstance = jest.fn()
jest.mock('../services/whatsappInstanceService', () => ({
  getWhatsappInstanceByProviderInstanceId: (...args) => mockGetInstance(...args),
}))

const resolveWebhookCompany = require('../middleware/resolveWebhookCompany')

function fakeReq(instanceId) {
  return { method: 'POST', path: '/', body: { instanceId, event_type: 'message_received' } }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

const INSTANCE = {
  id: 4,
  company_id: 2,
  instance_id: 'instance118446',
  is_default: true,
}

beforeEach(() => {
  jest.clearAllMocks()
  resolveWebhookCompany._test.clearResolveCache()
})

test('resolução bem-sucedida é cacheada: 2º webhook da mesma instância não consulta o banco', async () => {
  mockGetInstance.mockResolvedValue({ instance: INSTANCE })
  const req1 = fakeReq('instance118446')
  const req2 = fakeReq('instance118446')

  await resolveWebhookCompany(req1, fakeRes(), jest.fn())
  await resolveWebhookCompany(req2, fakeRes(), jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(1)
  expect(req2.webhookContext).toMatchObject({
    company_id: 2,
    whatsapp_instance_id: 4,
    provider: 'ultramsg',
  })
})

test('instância não mapeada NÃO entra no cache', async () => {
  mockGetInstance.mockResolvedValue({ instance: null, error: 'nao encontrada' })
  const res1 = fakeRes()
  const res2 = fakeRes()

  await resolveWebhookCompany(fakeReq('inst-x'), res1, jest.fn())
  await resolveWebhookCompany(fakeReq('inst-x'), res2, jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(2)
  expect(res1.body?.ignored).toBe('instance_not_mapped')
  expect(resolveWebhookCompany._test.cacheSize()).toBe(0)
})

test('erro de banco NÃO entra no cache e responde 500 (provedor reentrega)', async () => {
  mockGetInstance.mockResolvedValue({ code: 'DB_ERROR', error: 'boom' })
  const res = fakeRes()
  await resolveWebhookCompany(fakeReq('inst-y'), res, jest.fn())
  expect(res.statusCode).toBe(500)
  expect(resolveWebhookCompany._test.cacheSize()).toBe(0)
})

test('cache expira após o TTL (30s) e volta ao banco', async () => {
  mockGetInstance.mockResolvedValue({ instance: INSTANCE })
  const base = Date.now()
  const spy = jest.spyOn(Date, 'now').mockReturnValue(base)

  await resolveWebhookCompany(fakeReq('instance118446'), fakeRes(), jest.fn())
  spy.mockReturnValue(base + 31_000)
  await resolveWebhookCompany(fakeReq('instance118446'), fakeRes(), jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(2)
  spy.mockRestore()
})
