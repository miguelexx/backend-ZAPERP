const mockProvider = {}
const mockUpdates = []
const mockScheduleResend = jest.fn()

const mockInsertedMessage = {
  id: 701,
  company_id: 1,
  conversa_id: 10,
  autor_usuario_id: 5,
  texto: 'video.mp4',
  tipo: 'video',
  url: '/uploads/video.mp4',
  nome_arquivo: 'video.mp4',
  direcao: 'out',
  status: 'pending',
  status_mensagem: 'pending',
  criado_em: '2026-07-29T12:00:00.000Z',
}

jest.mock('../config/supabase', () => ({
  from: jest.fn((table) => {
    const chain = {
      insert: jest.fn(() => chain),
      update: jest.fn((payload) => {
        mockUpdates.push({ table, payload })
        return chain
      }),
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      single: jest.fn(async () => ({ data: { ...mockInsertedMessage }, error: null })),
      maybeSingle: jest.fn(async () => (
        table === 'usuarios'
          ? { data: { nome: 'Atendente', mostrar_nome_ao_cliente: true }, error: null }
          : { data: null, error: null }
      )),
    }
    return chain
  }),
}))

jest.mock('../services/providers', () => ({
  getProvider: () => mockProvider,
}))

jest.mock('../helpers/empresaModoSimplesFlag', () => ({
  empresaModoSimplesAtivo: jest.fn(async () => true),
}))

jest.mock('../services/atendimentoModoSimplesService', () => ({
  aplicarModoSimplesNoPayload: jest.fn((payload) => payload),
  recalcularStatusPorUltimaMensagem: jest.fn(async () => ({
    atendimento_modo_simples: true,
    modo_simples_aguardando: null,
    conversa: {},
  })),
  limparAguardandoAtendenteModoSimples: jest.fn(),
  getUltimaMensagemReal: jest.fn(),
  resolverModoSimplesAguardando: jest.fn(),
}))

jest.mock('../services/outboundMediaResendService', () => ({
  scheduleOutboundMediaResend: (...args) => mockScheduleResend(...args),
}))

jest.mock('../services/pendingOutboundReconciliationService', () => ({
  schedulePendingOutboundReconciliation: jest.fn(),
}))

const { _test } = require('../controllers/chatController')
const { enviarArquivoProcessarUm, buildMediaClientTempIdDedupResult } = _test
const originalAppUrl = process.env.APP_URL

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

function request() {
  return {
    body: {},
    app: { get: () => null },
  }
}

function videoFile() {
  return {
    path: 'C:\\uploads\\video.mp4',
    filename: 'video.mp4',
    originalname: 'video.mp4',
    mimetype: 'video/mp4',
    size: 1024,
  }
}

const context = {
  company_id: 1,
  user_id: 5,
  conversa_id: 10,
  telefoneParaEnvio: '5511999999999',
  whatsappInstanceId: 3,
  io: null,
  captionUsuario: '',
  clientTempId: null,
}

beforeEach(() => {
  mockUpdates.length = 0
  mockScheduleResend.mockReset()
  for (const key of Object.keys(mockProvider)) delete mockProvider[key]
  process.env.APP_URL = 'https://app.example.test'
})

afterAll(() => {
  if (originalAppUrl == null) delete process.env.APP_URL
  else process.env.APP_URL = originalAppUrl
})

test('não confirma HTTP enquanto upload e envio ao provedor ainda estão em andamento', async () => {
  const upload = deferred()
  const send = deferred()
  mockProvider.uploadMedia = jest.fn(() => upload.promise)
  mockProvider.sendVideo = jest.fn(() => send.promise)

  let settled = false
  const processing = enviarArquivoProcessarUm(request(), videoFile(), context)
    .then((result) => {
      settled = true
      return result
    })

  await nextTurn()
  expect(mockProvider.uploadMedia).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)

  upload.resolve({ ok: true, url: 'https://cdn.example.test/video.mp4' })
  await nextTurn()
  expect(mockProvider.sendVideo).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)

  send.resolve({ ok: true, messageId: 'BAE543FE1CE17AFA' })
  const result = await processing

  expect(result).toMatchObject({
    ok: true,
    msg: {
      id: 701,
      status: 'sent',
      status_mensagem: 'sent',
      whatsapp_id: 'BAE543FE1CE17AFA',
    },
  })
  expect(mockScheduleResend).not.toHaveBeenCalled()
})

test('falha de upload não é apresentada como sucesso e deixa recuperação registrada', async () => {
  process.env.APP_URL = 'http://localhost:3000'
  mockProvider.uploadMedia = jest.fn(async () => ({ ok: false, error: 'timeout_upload' }))
  mockProvider.sendVideo = jest.fn()

  const result = await enviarArquivoProcessarUm(request(), videoFile(), context)

  expect(result).toMatchObject({
    ok: false,
    status: 502,
    msg: {
      id: 701,
      status: 'erro',
      status_mensagem: 'erro',
    },
  })
  expect(mockProvider.sendVideo).not.toHaveBeenCalled()
  expect(mockUpdates.some(({ table, payload }) =>
    table === 'mensagens' && payload.status === 'erro' && payload.status_mensagem === 'erro'
  )).toBe(true)
  expect(mockScheduleResend).toHaveBeenCalledWith(expect.objectContaining({
    companyId: 1,
    mensagemId: 701,
  }))
})

test('recusa do provedor após upload também retorna falha em vez de sucesso de persistência', async () => {
  mockProvider.uploadMedia = jest.fn(async () => ({
    ok: true,
    url: 'https://cdn.example.test/video.mp4',
  }))
  mockProvider.sendVideo = jest.fn(async () => ({
    ok: false,
    error: 'provider_timeout',
  }))

  const result = await enviarArquivoProcessarUm(request(), videoFile(), context)

  expect(result).toMatchObject({
    ok: false,
    status: 502,
    msg: {
      id: 701,
      status: 'erro',
      status_mensagem: 'erro',
    },
  })
  expect(mockProvider.sendVideo).toHaveBeenCalledTimes(1)
  expect(mockScheduleResend).toHaveBeenCalledWith(expect.objectContaining({
    companyId: 1,
    mensagemId: 701,
  }))
})

test('deduplicação não transforma linha pending sem ID do provedor em sucesso prematuro', () => {
  expect(buildMediaClientTempIdDedupResult({
    id: 701,
    status: 'pending',
    status_mensagem: 'pending',
    whatsapp_id: null,
    provider_queue_id: null,
  })).toMatchObject({
    ok: false,
    status: 409,
    deduplicated: true,
  })
})

test('deduplicação confirma apenas quando há evidência persistida de aceite do provedor', () => {
  expect(buildMediaClientTempIdDedupResult({
    id: 701,
    status: 'pending',
    status_mensagem: 'sending',
    provider_queue_id: '35096',
  })).toMatchObject({
    ok: true,
    deduplicated: true,
  })

  expect(buildMediaClientTempIdDedupResult({
    id: 702,
    status: 'sent',
    status_mensagem: 'sent',
    whatsapp_id: 'BAE543FE1CE17AFA',
  })).toMatchObject({
    ok: true,
    deduplicated: true,
  })
})
