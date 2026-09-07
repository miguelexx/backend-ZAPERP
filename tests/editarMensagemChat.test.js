/**
 * PATCH /chats/:id/mensagens/:mensagem_id — edição de texto/legenda.
 * Isola o handler com supabase mock global + provider/policy/identity.
 */

const mockProvider = { editMessage: jest.fn() }
jest.mock('../services/providers', () => ({ getProvider: jest.fn(() => mockProvider) }))
jest.mock('../services/chat/access/conversationPolicy', () => ({
  assertPermissaoConversa: jest.fn(),
  podeAssumirConversaPorPerfil: jest.fn(),
  assertPodeEnviarMensagem: jest.fn(),
}))
jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveConversationWhatsappInstance: jest.fn().mockResolvedValue(10),
  resolveConversationProvider: jest.fn().mockResolvedValue('whapi'),
}))
jest.mock('../services/chat/presentation/messageAuthorEnrichment', () => ({
  textoParaEnvioWhatsapp: (t) => t,
  getUsuarioParaEnvioCliente: jest.fn().mockResolvedValue({ nome: null, mostrar: false }),
  enrichMensagemComAutorUsuario: jest.fn(async (_s, _c, msg) => msg),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
  emitirParaUsuario: jest.fn(),
}))

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { resolveConversationProvider } = require('../services/chat/identity/conversationAddressService')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const { editarMensagem } = require('../controllers/chatController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function buildReq(overrides = {}) {
  return {
    user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [] },
    params: { id: '10', mensagem_id: '42' },
    body: { texto: 'texto novo' },
    app: { get: jest.fn(() => ({ EVENTS: {} })) },
    ...overrides,
  }
}

const conversa = { id: 10, telefone: '5534988887777', whatsapp_instance_id: 10, criado_em: '2026-09-07T12:00:00.000Z' }

function msgRow(extra = {}) {
  return {
    id: 42,
    conversa_id: 10,
    criado_em: new Date().toISOString(),
    direcao: 'out',
    autor_usuario_id: 2,
    whatsapp_id: 'AbCd-EfGh',
    tipo: 'texto',
    texto: 'texto antigo',
    url: null,
    nome_arquivo: null,
    apagada_para_todos: false,
    status: 'sent',
    ...extra,
  }
}

describe('editarMensagem', () => {
  let chain
  beforeEach(() => {
    jest.clearAllMocks()
    assertPermissaoConversa.mockResolvedValue({ ok: true })
    resolveConversationProvider.mockResolvedValue('whapi')
    getProvider.mockReturnValue(mockProvider)
    mockProvider.editMessage.mockResolvedValue({ ok: true, messageId: 'AbCd-EfGh' })
    chain = supabase.from()
  })

  test('sem permissão de ver a conversa → 403 e não chama provider', async () => {
    assertPermissaoConversa.mockResolvedValueOnce({ ok: false, status: 403, error: 'Conversa de outro setor' })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })

  test('empresa B não vê conversa da empresa A → 404 e não chama provider', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    const res = buildRes()
    await editarMensagem(buildReq({ user: { company_id: 99, id: 2, perfil: 'atendente', departamento_ids: [] } }), res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })

  test('mensagem inbound → 403', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow({ direcao: 'in' }), error: null })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EDIT_INBOUND' }))
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })

  test('outro autor (não admin) → 403', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow({ autor_usuario_id: 99 }), error: null })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })

  test('janela > 15 min → 409', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({
        data: msgRow({ criado_em: new Date(Date.now() - 16 * 60 * 1000).toISOString() }),
        error: null,
      })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EDIT_WINDOW_EXPIRED' }))
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })

  test('UltraMSG sem editMessage → 422', async () => {
    resolveConversationProvider.mockResolvedValueOnce('ultramsg')
    getProvider.mockReturnValueOnce({})
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow(), error: null })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EDIT_NOT_SUPPORTED' }))
  })

  test('Whapi edita texto, persiste e emite mensagem_editada', async () => {
    const saved = {
      ...msgRow(),
      texto: 'texto novo',
      editada: true,
      editada_em: '2026-09-07T20:00:00.000Z',
    }
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow(), error: null })
      .mockResolvedValueOnce({ data: saved, error: null })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(mockProvider.editMessage).toHaveBeenCalledWith(
      '5534988887777',
      'AbCd-EfGh',
      'texto novo',
      expect.objectContaining({ companyId: 1, whatsappInstanceId: 10 })
    )
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      mensagem_id: 42,
      mensagem: expect.objectContaining({ texto: 'texto novo', editada: true, editado: true }),
    }))
    expect(emitirEventoEmpresaConversa).toHaveBeenCalledWith(
      expect.anything(),
      1,
      10,
      'mensagem_editada',
      expect.objectContaining({ id: 42, texto: 'texto novo', editado: true, company_id: 1 })
    )
  })

  test('legenda de imagem vazia chama provider com allowEmpty', async () => {
    const media = msgRow({ tipo: 'imagem', texto: 'legenda antiga', nome_arquivo: 'foto.jpg' })
    const saved = { ...media, texto: '(imagem)', editada: true }
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: media, error: null })
      .mockResolvedValueOnce({ data: saved, error: null })
    const res = buildRes()
    await editarMensagem(buildReq({ body: { caption: '   ' } }), res)
    expect(mockProvider.editMessage).toHaveBeenCalledWith(
      '5534988887777',
      'AbCd-EfGh',
      '',
      expect.objectContaining({ allowEmpty: true })
    )
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  test('áudio não é editável', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow({ tipo: 'audio' }), error: null })
    const res = buildRes()
    await editarMensagem(buildReq(), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EDIT_TYPE_UNSUPPORTED' }))
    expect(mockProvider.editMessage).not.toHaveBeenCalled()
  })
})
