/**
 * Reenvio manual (retryController): falha transitória do provedor (timeout/rede/429/5xx)
 * NÃO pode virar 'failed' definitivo — o provedor pode ter aceitado (timeout pós-aceite)
 * e um novo clique duplicaria no WhatsApp. Deve manter pending/sending + reconciliação.
 * Recusa definitiva (4xx/corpo de erro) continua marcando failed, como antes.
 */

const mockUpdates = []
let mockMensagemRow
let mockConversaRow

jest.mock('../config/supabase', () => ({
  from: (table) => ({
    select: () => {
      const q = {
        eq: () => q,
        maybeSingle: async () => ({
          data: table === 'mensagens' ? mockMensagemRow : table === 'conversas' ? mockConversaRow : null,
          error: null,
        }),
      }
      return q
    },
    update: (patch) => {
      mockUpdates.push({ table, patch })
      const q = { eq: () => q, then: (resolve) => resolve({ error: null }) }
      return q
    },
  }),
}))

const mockSchedule = jest.fn()
jest.mock('../services/pendingOutboundReconciliationService', () => ({
  schedulePendingOutboundReconciliation: (...args) => mockSchedule(...args),
}))

jest.mock('../services/chat/outbound/retryEligibility', () => ({
  avaliarElegibilidadeReenvio: () => ({ permitido: true }),
  captionUsuarioDeMidiaPersistida: () => '',
}))

jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveConversationWhatsappInstance: async () => null,
  resolverTelefoneEnvioDaConversa: async () => ({ telefone: '5588999990000', erro: null }),
  resolveConversationProvider: async () => 'whapi',
}))

jest.mock('../services/chat/presentation/messageAuthorEnrichment', () => ({
  getUsuarioParaEnvioCliente: async () => ({ nome: 'Atendente' }),
  textoParaEnvioWhatsapp: (texto) => texto,
}))

jest.mock('../services/chat/outbound/forwardMediaResolver', () => ({
  resolveForwardMediaForProvider: async () => ({ ok: true, url: 'https://cdn.example/x.jpg' }),
}))

jest.mock('../helpers/midiaMensagemHelper', () => ({
  captionWhatsappParaMidia: () => '',
  textoMensagemMidiaParaBanco: () => '[imagem]',
}))

const mockProvider = {
  sendText: jest.fn(),
  sendImage: jest.fn(),
  sendFile: jest.fn(),
}
jest.mock('../services/providers', () => ({
  getProvider: () => mockProvider,
}))

const retryController = require('../controllers/chat/retryController')

function fakeIo() {
  const io = { EVENTS: {}, emit: jest.fn() }
  io.to = () => io
  return io
}

function fakeReq() {
  return {
    user: { company_id: 1, id: 9, perfil: 'atendente' },
    params: { id: '10', mensagem_id: '55' },
    app: { get: () => fakeIo() },
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUpdates.length = 0
  mockMensagemRow = {
    id: 55, conversa_id: 10, company_id: 1, direcao: 'out', tipo: 'imagem',
    texto: '[imagem]', url: '/uploads/x.jpg', nome_arquivo: 'x.jpg',
    status: 'erro', status_mensagem: 'erro', whatsapp_id: null,
    provider_queue_id: null, client_temp_id: 'tmp-1',
    criado_em: new Date().toISOString(), whatsapp_instance_id: null,
  }
  mockConversaRow = { id: 10, telefone: '5588999990000', cliente_id: 7, chat_lid: null, tipo: null, whatsapp_instance_id: null }
})

describe('reenviarMidiaMensagem — classificação de falha', () => {
  test('5xx do provedor mantém pending/sending, agenda reconciliação e responde ok:true transient', async () => {
    mockProvider.sendImage.mockResolvedValue({ ok: false, messageId: null, httpStatus: 503, error: 'service unavailable' })
    const res = fakeRes()
    await retryController.reenviarMidiaMensagem(fakeReq(), res)

    expect(res.body.ok).toBe(true)
    expect(res.body.transient).toBe(true)
    expect(res.body.error).toBeNull()
    expect(res.body.mensagem.status).toBe('pending')
    expect(res.body.mensagem.status_mensagem).toBe('sending')
    const up = mockUpdates.find((u) => u.table === 'mensagens')
    expect(up.patch).toMatchObject({ status: 'pending', status_mensagem: 'sending' })
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ companyId: 1, mensagemId: 55 }))
  })

  test('exceção do provedor (transporte) vira transitória — nunca 500 sem atualizar estado', async () => {
    mockProvider.sendImage.mockRejectedValue(new Error('fetch failed'))
    const res = fakeRes()
    await retryController.reenviarMidiaMensagem(fakeReq(), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.transient).toBe(true)
    expect(res.body.mensagem.status).toBe('pending')
    expect(mockSchedule).toHaveBeenCalled()
  })

  test('recusa definitiva (400) continua marcando failed e respondendo ok:false com erro', async () => {
    mockProvider.sendImage.mockResolvedValue({ ok: false, messageId: null, httpStatus: 400, error: 'bad media' })
    const res = fakeRes()
    await retryController.reenviarMidiaMensagem(fakeReq(), res)

    expect(res.body.ok).toBe(false)
    expect(res.body.transient).toBeUndefined()
    expect(res.body.error).toContain('bad media')
    const up = mockUpdates.find((u) => u.table === 'mensagens')
    expect(up.patch).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  test('aceite Whapi sem ACK fica pending/sending com reconciliação (id salvo para rastrear)', async () => {
    mockProvider.sendImage.mockResolvedValue({
      ok: true,
      provider: 'whapi',
      ackConfirmed: false,
      messageId: 'A1B2C3D4E5F6A1B2C3D4E5F6',
      httpStatus: 200,
      error: null,
    })
    const res = fakeRes()
    await retryController.reenviarMidiaMensagem(fakeReq(), res)

    expect(res.body.ok).toBe(true)
    expect(res.body.transient).toBeUndefined()
    expect(res.body.mensagem.status).toBe('pending')
    expect(res.body.mensagem.whatsapp_id).toBe('A1B2C3D4E5F6A1B2C3D4E5F6')
    expect(mockSchedule).toHaveBeenCalled()
  })
})

describe('reenviarTextoMensagem — exceção de transporte', () => {
  test('exceção do sendText vira transitória (pending + reconciliação), não 500', async () => {
    mockMensagemRow = { ...mockMensagemRow, tipo: 'texto', texto: 'olá', url: null }
    mockProvider.sendText.mockRejectedValue(new Error('socket hang up'))
    const res = fakeRes()
    await retryController.reenviarTextoMensagem(fakeReq(), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.transient).toBe(true)
    expect(res.body.mensagem.status).toBe('pending')
    expect(mockSchedule).toHaveBeenCalled()
  })
})
