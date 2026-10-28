/**
 * Auto-sync de grupos/chats ao conectar um canal Whapi (whatsappIntegrationController).
 *
 * Invariante: num canal Whapi, nada importava a lista de grupos automaticamente — o
 * auto-sync só existia no caminho de status do UltraMSG. Agora `persistWhapiHealth`
 * dispara `syncGroups`+`syncFromChats` na transição desconectado→conectado.
 *
 * Regras cobertas:
 *  - dispara UMA vez na transição false→true (não a cada poll com connected:true);
 *  - throttle POR EMPRESA: 2 instâncias da mesma empresa conectando juntas sincronizam 1x;
 *  - reconexão (false→true) dentro do throttle NÃO re-sincroniza;
 *  - passado o throttle, uma nova transição re-sincroniza.
 */

jest.mock('../config/supabase', () => ({}))
jest.mock('../services/ultramsgIntegrationService', () => ({
  getStatus: jest.fn(), getQrCodeImage: jest.fn(), restartInstance: jest.fn(),
  getMe: jest.fn(), getPhoneCode: jest.fn(), buildMeSummary: jest.fn(),
}))
jest.mock('../services/whatsappConfigService', () => ({}))
jest.mock('../services/whatsappInstanceService', () => ({ updateWhatsappInstance: jest.fn() }))
jest.mock('../services/queueManager', () => ({ enqueue: jest.fn(), getActiveJob: jest.fn(), requestCancelJob: jest.fn(), JOB_TIPOS: {} }))
jest.mock('../services/whatsappConnectGuardService', () => ({
  checkGuard: jest.fn(), recordQrServed: jest.fn(), resetOnConnected: jest.fn(), getAttempts: jest.fn(), THROTTLE_SECONDS: 0,
}))
jest.mock('../services/configOperacionalService', () => ({ getConfig: jest.fn() }))
jest.mock('../services/providers', () => ({ getProvider: jest.fn() }))
jest.mock('../services/chat/identity/conversationAddressService', () => ({ resolveCompanyWhatsappProvider: jest.fn() }))
jest.mock('../services/providers/whapi/partner', () => ({}))

// O alvo: espionar que o auto-sync chama estes a nível de empresa.
// Prefixo `mock*` exigido pelo jest para referência dentro da factory de jest.mock.
const mockSyncGroups = jest.fn(async () => ({ ok: true, totalFetched: 2, inserted: 2, updated: 0, skipped: 0, errors: [] }))
const mockSyncFromChats = jest.fn(async () => ({ ok: true, totalFetched: 5, inserted: 3, updated: 2, skipped: 0, errors: [] }))
jest.mock('../services/ultramsgGroupsSyncService', () => ({
  syncGroups: mockSyncGroups, syncFromChats: mockSyncFromChats, syncAll: jest.fn(),
}))

const syncGroups = mockSyncGroups
const syncFromChats = mockSyncFromChats
const { _test } = require('../controllers/whatsappIntegrationController')

const flush = () => new Promise((r) => setImmediate(r))
const CONN = { ok: true, connected: true, status: 'AUTH' }
const OFF = { ok: true, connected: false, status: 'UNAUTHORIZED' }

beforeEach(() => {
  jest.clearAllMocks()
  _test.resetWhapiAutoSyncState()
})

test('dispara uma vez na transição desconectado→conectado e não a cada poll', async () => {
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN) // poll repetido, já conectado
  await flush()
  expect(syncGroups).toHaveBeenCalledTimes(1)
  expect(syncGroups).toHaveBeenCalledWith(10)
  expect(syncFromChats).toHaveBeenCalledTimes(1)
})

test('throttle por empresa: duas instâncias conectando juntas sincronizam só uma vez', async () => {
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
  _test.maybeAutoSyncWhapiOnConnect(10, 2, CONN) // outra instância, mesma empresa
  await flush()
  expect(syncGroups).toHaveBeenCalledTimes(1)
})

test('empresas diferentes sincronizam de forma independente', async () => {
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
  _test.maybeAutoSyncWhapiOnConnect(20, 1, CONN)
  await flush()
  expect(syncGroups).toHaveBeenCalledTimes(2)
  expect(syncGroups).toHaveBeenCalledWith(10)
  expect(syncGroups).toHaveBeenCalledWith(20)
})

test('desconectar e reconectar dentro do throttle não re-sincroniza', async () => {
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
  await flush()
  _test.maybeAutoSyncWhapiOnConnect(10, 1, OFF)   // caiu
  _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)  // voltou, mas dentro dos 10 min
  await flush()
  expect(syncGroups).toHaveBeenCalledTimes(1)
})

test('passado o throttle, nova transição re-sincroniza', async () => {
  const realNow = Date.now
  try {
    let t = 1_000_000
    Date.now = () => t
    _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
    await flush()
    expect(syncGroups).toHaveBeenCalledTimes(1)

    _test.maybeAutoSyncWhapiOnConnect(10, 1, OFF)
    t += 11 * 60 * 1000 // passa dos 10 min
    _test.maybeAutoSyncWhapiOnConnect(10, 1, CONN)
    await flush()
    expect(syncGroups).toHaveBeenCalledTimes(2)
  } finally {
    Date.now = realNow
  }
})

test('connected:false nunca dispara sync', async () => {
  _test.maybeAutoSyncWhapiOnConnect(10, 1, OFF)
  await flush()
  expect(syncGroups).not.toHaveBeenCalled()
  expect(syncFromChats).not.toHaveBeenCalled()
})
