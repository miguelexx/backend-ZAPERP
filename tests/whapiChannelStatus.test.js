/**
 * whapiChannelStatus (GET /chats/whapi-status) — alimenta o overlay vermelho de
 * "canal desconectado" do frontend.
 *
 * Invariante crítica: pintar o sistema inteiro de vermelho é disruptivo, então
 * o endpoint só pode acusar desconexão quando a empresa É Whapi E o canal está
 * comprovadamente fora do AUTH. Provider diferente, sem empresa ou qualquer erro
 * devem devolver connected:true / isWhapi:false (overlay nunca aparece por engano).
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
const { whapiChannelStatus } = require('../controllers/chat/integrationController')

function mockRes() {
  return { json: jest.fn(function (body) { this.body = body; return this }) }
}

beforeEach(() => jest.clearAllMocks())

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
  getProvider.mockReturnValue({
    getConnectionStatus: jest.fn().mockResolvedValue({ connected: true, status: 'AUTH' }),
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: true, status: 'AUTH' })
})

test('Whapi desconectado → isWhapi:true, connected:false (acende o overlay)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  getProvider.mockReturnValue({
    getConnectionStatus: jest.fn().mockResolvedValue({ connected: false, status: 'UNAUTHORIZED' }),
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: true, connected: false })
})

test('erro ao consultar o provider → fail-safe connected:true (não acende por engano)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  getProvider.mockReturnValue({
    getConnectionStatus: jest.fn().mockRejectedValue(new Error('timeout')),
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ isWhapi: false, connected: true })
})
