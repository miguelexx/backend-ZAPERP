/**
 * whapiChannelStatus (GET /chats/whapi-status) — alimenta o overlay vermelho de
 * "canal desconectado" do frontend.
 *
 * Invariante crítica: pintar o sistema inteiro de vermelho é disruptivo, então
 * o endpoint só pode acusar desconexão quando a empresa É Whapi E TODOS os
 * canais Whapi ativos estão comprovadamente fora do AUTH. Provider diferente,
 * sem empresa, pelo menos 1 AUTH, ou qualquer erro devem devolver connected:true
 * (overlay nunca aparece por engano). 2+ canais sem is_default não podem acender
 * o overlay — getConnectionStatus({companyId}) falha nesse caso em produção.
 */

jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveCompanyWhatsappProvider: jest.fn(),
}))
jest.mock('../services/providers', () => ({
  getProvider: jest.fn(),
}))
// Dependências de topo do controller que não interessam a este teste:
jest.mock('../config/supabase', () => ({}))
jest.mock('../services/ultramsgIntegrationService', () => ({ getStatus: jest.fn() }))
jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn(),
  sanitizeWhatsappInstance: jest.fn(),
}))

const { resolveCompanyWhatsappProvider } = require('../services/chat/identity/conversationAddressService')
const { getProvider } = require('../services/providers')
const { listWhatsappInstances } = require('../services/whatsappInstanceService')
const { whapiChannelStatus } = require('../controllers/chat/integrationController')

function mockRes() {
  return { json: jest.fn(function (body) { this.body = body; return this }) }
}

function whapiRow(id) {
  return { id, provider: 'whapi', ativo: true, is_default: false }
}

function mockHealthByInstance(map) {
  const getConnectionStatus = jest.fn(async ({ whatsappInstanceId }) => {
    const hit = map[whatsappInstanceId]
    if (!hit) return { connected: false, status: 'UNKNOWN' }
    if (hit instanceof Error) throw hit
    return hit
  })
  getProvider.mockReturnValue({ getConnectionStatus })
  return getConnectionStatus
}

beforeEach(() => {
  jest.clearAllMocks()
  listWhatsappInstances.mockResolvedValue({ instances: [], error: null })
})

test('sem empresa autenticada → connected:true, isWhapi:false', async () => {
  const res = mockRes()
  await whapiChannelStatus({ user: {} }, res)
  expect(res.body).toMatchObject({ isWhapi: false, connected: true })
  expect(resolveCompanyWhatsappProvider).not.toHaveBeenCalled()
})

test('company_id NaN / inválido → fail-safe sem consultar provider', async () => {
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: Number.NaN } }, res)
  expect(res.body).toMatchObject({ isWhapi: false, connected: true })
  expect(resolveCompanyWhatsappProvider).not.toHaveBeenCalled()
})

test('provider UltraMSG → nunca dispara (connected:true, isWhapi:false)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('ultramsg')
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: false, connected: true, provider: 'ultramsg' })
  expect(getProvider).not.toHaveBeenCalled()
})

test('Whapi conectado (AUTH) → isWhapi:true, connected:true', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({ instances: [whapiRow(10)], error: null })
  const getConnectionStatus = mockHealthByInstance({
    10: { connected: true, status: 'AUTH' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: true, status: 'AUTH' })
  expect(getConnectionStatus).toHaveBeenCalledWith(expect.objectContaining({
    companyId: 7,
    whatsappInstanceId: 10,
  }))
})

test('Whapi desconectado → isWhapi:true, connected:false (acende o overlay)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({ instances: [whapiRow(10)], error: null })
  mockHealthByInstance({
    10: { connected: false, status: 'UNAUTHORIZED' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: false })
})

test('dois canais Whapi AUTH sem is_default → connected:true (não acende o overlay)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  const getConnectionStatus = mockHealthByInstance({
    10: { connected: true, status: 'AUTH' },
    11: { connected: true, status: 'AUTH' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: true, status: 'AUTH' })
  expect(getConnectionStatus).toHaveBeenCalledTimes(2)
})

test('dois canais: um AUTH e um UNAUTHORIZED → connected:true (overlay não bloqueia a empresa)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  mockHealthByInstance({
    10: { connected: false, status: 'UNAUTHORIZED' },
    11: { connected: true, status: 'AUTH' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: true })
})

test('dois canais Whapi ambos UNAUTHORIZED → connected:false (acende o overlay)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  mockHealthByInstance({
    10: { connected: false, status: 'UNAUTHORIZED' },
    11: { connected: false, status: 'UNAUTHORIZED' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: false })
})

test('erro ao consultar o provider (throw) → fail-safe connected:true (não acende por engano)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({ instances: [whapiRow(10)], error: null })
  mockHealthByInstance({
    10: new Error('timeout'),
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ connected: true })
  expect(res.body.connected).toBe(true)
})

test('dois canais sem default → not_configured NÃO acende overlay', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  mockHealthByInstance({
    10: { connected: false, status: 'not_configured' },
    11: { connected: false, status: 'not_configured' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ connected: true })
})

test('health error (sem throw) NÃO acende overlay', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({ instances: [whapiRow(10)], error: null })
  mockHealthByInstance({
    10: { connected: false, status: 'error' },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: true })
})
