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

// =====================================================================
// Queda de INTERNET × aparelho DESVINCULADO (06/11/2026)
//
// A tela deixou de ser só um aviso vermelho: ela agora oferece o QR Code.
// Mandar o supervisor escanear um QR porque a rede oscilou é pior do que não
// avisar nada — e a Whapi reconecta sozinha por INIT → LAUNCH → AUTH em 2-3s.
// Por isso a regra virou LISTA DE PERMISSÃO: só QR (code 3) acusa desvínculo.
// Escala oficial do /health: 1 INIT, 2 LAUNCH, 3 QR, 4 AUTH, 5 ERROR
// (+ STOP = canal desativado e SYNC_ERROR = falha de sync, fora da escala).
// =====================================================================

async function statusComHealth(health) {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({ instances: [whapiRow(10)], error: null })
  mockHealthByInstance({ 10: health })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  return res.body
}

test('canal RECONECTANDO (code 2 / LAUNCH) → connected:true (rede oscilando não vira QR)', async () => {
  const body = await statusComHealth({ connected: false, status: 'LAUNCH', code: 2 })
  expect(body).toMatchObject({ isWhapi: true, connected: true, unlinked: false })
})

test('canal SUBINDO (code 1 / INIT) → connected:true', async () => {
  const body = await statusComHealth({ connected: false, status: 'INIT', code: 1 })
  expect(body.connected).toBe(true)
})

test('canal DESATIVADO (STOP) → connected:true (QR não resolve cobrança/desativação)', async () => {
  const body = await statusComHealth({ connected: false, status: 'STOP' })
  expect(body.connected).toBe(true)
})

test('SYNC_ERROR → connected:true (envio continua; não é desvínculo)', async () => {
  const body = await statusComHealth({ connected: false, status: 'SYNC_ERROR' })
  expect(body.connected).toBe(true)
})

test('code 5 (ERROR) → connected:true', async () => {
  const body = await statusComHealth({ connected: false, status: 'ERROR', code: 5 })
  expect(body.connected).toBe(true)
})

test('QR (code 3) → connected:false + unlinked:true (único caso que acende)', async () => {
  const body = await statusComHealth({ connected: false, status: 'QR', code: 3 })
  expect(body).toMatchObject({
    isWhapi: true,
    connected: false,
    unlinked: true,
    status: 'QR',
    statusCode: 3,
  })
})

test('QR só no raw.status.code (sem campo code) → acende do mesmo jeito', async () => {
  const body = await statusComHealth({
    connected: false,
    status: 'QR',
    raw: { status: { code: 3, text: 'QR' } },
  })
  expect(body).toMatchObject({ connected: false, unlinked: true })
})

test('texto desvinculado mas code transitório → o CÓDIGO manda (não acende)', async () => {
  const body = await statusComHealth({ connected: false, status: 'UNAUTHORIZED', code: 2 })
  expect(body.connected).toBe(true)
})

test('estado novo/desconhecido da Whapi → não acende (lista de permissão)', async () => {
  const body = await statusComHealth({ connected: false, status: 'FOI_PARA_A_LUA' })
  expect(body.connected).toBe(true)
})

test('um canal QR e outro LAUNCH → connected:true (nem todos desvinculados)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  mockHealthByInstance({
    10: { connected: false, status: 'QR', code: 3 },
    11: { connected: false, status: 'LAUNCH', code: 2 },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body.connected).toBe(true)
})

test('dois canais QR → connected:false (os dois desvinculados)', async () => {
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  listWhatsappInstances.mockResolvedValue({
    instances: [whapiRow(10), whapiRow(11)],
    error: null,
  })
  mockHealthByInstance({
    10: { connected: false, status: 'QR', code: 3 },
    11: { connected: false, status: 'QR', code: 3 },
  })
  const res = mockRes()
  await whapiChannelStatus({ user: { company_id: 7 } }, res)
  expect(res.body).toMatchObject({ connected: false, unlinked: true })
})
