/**
 * Cache TTL do resolvedor channel_id→instância do webhook Whapi.
 * Sucesso é cacheado 30s (1 SELECT para N webhooks do mesmo canal);
 * erro de banco e canal não mapeado NUNCA são cacheados (retry imediato).
 */

const mockGetInstance = jest.fn()
jest.mock('../services/whatsappInstanceService', () => ({
  getWhatsappInstanceByProviderInstanceId: (...args) => mockGetInstance(...args),
}))

const resolveWhapiWebhookCompany = require('../middleware/resolveWhapiWebhookCompany')

function fakeReq(channelId) {
  return { method: 'POST', body: { channel_id: channelId } }
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
  id: 7,
  company_id: 3,
  instance_id: 'NEBULA-AER3B',
  telefone_conectado: '5588999990000',
  is_default: true,
  metadata: { sync_historico: 'off' },
}

beforeEach(() => {
  jest.clearAllMocks()
  resolveWhapiWebhookCompany._test.clearResolveCache()
})

test('resolução bem-sucedida é cacheada: 2º webhook do mesmo canal não consulta o banco', async () => {
  mockGetInstance.mockResolvedValue({ instance: INSTANCE })
  const next1 = jest.fn()
  const next2 = jest.fn()
  const req1 = fakeReq('NEBULA-AER3B')
  const req2 = fakeReq('NEBULA-AER3B')

  await resolveWhapiWebhookCompany(req1, fakeRes(), next1)
  await resolveWhapiWebhookCompany(req2, fakeRes(), next2)

  expect(mockGetInstance).toHaveBeenCalledTimes(1)
  expect(next1).toHaveBeenCalled()
  expect(next2).toHaveBeenCalled()
  expect(req2.webhookContext).toMatchObject({
    company_id: 3,
    whatsapp_instance_id: 7,
    provider: 'whapi',
    sync_historico: 'off',
  })
})

test('canal não mapeado NÃO entra no cache (retry consulta de novo)', async () => {
  mockGetInstance.mockResolvedValue({ instance: null, error: 'nao encontrada' })
  const res1 = fakeRes()
  const res2 = fakeRes()

  await resolveWhapiWebhookCompany(fakeReq('CANAL-X'), res1, jest.fn())
  await resolveWhapiWebhookCompany(fakeReq('CANAL-X'), res2, jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(2)
  expect(res1.body?.ignored).toBe('instance_not_mapped')
  expect(resolveWhapiWebhookCompany._test.cacheSize()).toBe(0)
})

test('erro de banco NÃO entra no cache e responde 500 (Whapi reentrega)', async () => {
  mockGetInstance.mockResolvedValue({ code: 'DB_ERROR', error: 'boom' })
  const res = fakeRes()
  await resolveWhapiWebhookCompany(fakeReq('CANAL-Y'), res, jest.fn())
  expect(res.statusCode).toBe(500)
  expect(resolveWhapiWebhookCompany._test.cacheSize()).toBe(0)
})

test('cache expira após o TTL (30s) e volta ao banco', async () => {
  mockGetInstance.mockResolvedValue({ instance: INSTANCE })
  const base = Date.now()
  const spy = jest.spyOn(Date, 'now').mockReturnValue(base)

  await resolveWhapiWebhookCompany(fakeReq('NEBULA-AER3B'), fakeRes(), jest.fn())
  spy.mockReturnValue(base + 31_000)
  await resolveWhapiWebhookCompany(fakeReq('NEBULA-AER3B'), fakeRes(), jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(2)
  spy.mockRestore()
})

test('canais diferentes têm entradas independentes', async () => {
  mockGetInstance
    .mockResolvedValueOnce({ instance: INSTANCE })
    .mockResolvedValueOnce({ instance: { ...INSTANCE, id: 8, company_id: 9, instance_id: 'OUTRO-CANAL' } })
  const reqA = fakeReq('NEBULA-AER3B')
  const reqB = fakeReq('OUTRO-CANAL')

  await resolveWhapiWebhookCompany(reqA, fakeRes(), jest.fn())
  await resolveWhapiWebhookCompany(reqB, fakeRes(), jest.fn())

  expect(mockGetInstance).toHaveBeenCalledTimes(2)
  expect(reqA.webhookContext.company_id).toBe(3)
  expect(reqB.webhookContext.company_id).toBe(9)
})
