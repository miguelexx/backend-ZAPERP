/**
 * DELETE /chats/:id/mensagens/:mensagem_id (scope=all) — exclusão AUDITÁVEL.
 * Regras cobertas:
 *  - apaga no WhatsApp (provider.deleteMessage) antes de tocar no histórico;
 *  - NÃO sobrescreve texto/reply_meta (o balão original permanece visível no painel);
 *  - registra apagada_para_todos + apagada_em + apagada_por_usuario_id;
 *  - emite mensagem_excluida com quem/quando para as outras sessões.
 */

const mockProvider = { deleteMessage: jest.fn() }
jest.mock('../services/providers', () => ({ getProvider: jest.fn(() => mockProvider) }))
jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveConversationWhatsappInstance: jest.fn().mockResolvedValue(10),
  resolveConversationProvider: jest.fn().mockResolvedValue('whapi'),
}))
jest.mock('../services/chat/presentation/messageAuthorEnrichment', () => ({
  aplicarApagadaParaTodosNaMensagem: (m) => m,
  enrichMensagemComAutorUsuario: jest.fn(async (_s, _c, m) => m),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
  emitirParaUsuario: jest.fn(),
}))

const supabase = require('../config/supabase')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const { excluirMensagem } = require('../controllers/chatController')

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
    query: {},
    app: { get: jest.fn(() => ({ EVENTS: {} })) },
    ...overrides,
  }
}

const conversa = { id: 10, criado_em: '2026-09-07T12:00:00.000Z', telefone: '5534988887777', whatsapp_instance_id: 10 }

function msgRow(extra = {}) {
  return {
    id: 42,
    conversa_id: 10,
    criado_em: new Date().toISOString(),
    direcao: 'out',
    autor_usuario_id: 2,
    whatsapp_id: 'AbCd-EfGh',
    ...extra,
  }
}

describe('excluirMensagem — auditável (mantém conteúdo)', () => {
  let chain
  beforeEach(() => {
    jest.clearAllMocks()
    mockProvider.deleteMessage.mockResolvedValue(true)
    chain = supabase.from()
  })

  test('apaga no WhatsApp, mantém texto/reply e registra quem/quando + emite evento', async () => {
    const msgRevogada = {
      ...msgRow(),
      texto: 'mensagem original preservada',
      reply_meta: { name: 'Cliente', snippet: 'oi' },
      apagada_para_todos: true,
      apagada_em: '2026-09-23T10:00:00.000Z',
      apagada_por_usuario_id: 2,
    }
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null }) // conversa
      .mockResolvedValueOnce({ data: msgRow(), error: null }) // mensagem alvo
      .mockResolvedValueOnce({ data: msgRevogada, error: null }) // update ... select
      .mockResolvedValueOnce({ data: { nome: 'Maria' }, error: null }) // usuarios (quem apagou)

    const res = buildRes()
    await excluirMensagem(buildReq(), res)

    // apagou no WhatsApp
    expect(mockProvider.deleteMessage).toHaveBeenCalledWith(
      '5534988887777',
      'AbCd-EfGh',
      expect.objectContaining({ companyId: 1 })
    )

    // o update que marca a exclusão NÃO pode tocar em texto/reply_meta
    const updatePayloads = chain.update.mock.calls.map((c) => c[0])
    const revokeUpdate = updatePayloads.find((p) => p && p.apagada_para_todos === true)
    expect(revokeUpdate).toBeTruthy()
    expect(revokeUpdate).toHaveProperty('apagada_por_usuario_id', 2)
    expect(revokeUpdate).toHaveProperty('apagada_em')
    expect(revokeUpdate).not.toHaveProperty('texto')
    expect(revokeUpdate).not.toHaveProperty('reply_meta')

    // resposta preserva o conteúdo original e carrega os metadados de auditoria
    const body = res.json.mock.calls[0][0]
    expect(body).toMatchObject({ ok: true, apagada_para_todos: true })
    expect(body.mensagem).toMatchObject({
      texto: 'mensagem original preservada',
      apagada_por_usuario_id: 2,
      apagada_por_nome: 'Maria',
    })
    expect(body.mensagem.reply_meta).toEqual({ name: 'Cliente', snippet: 'oi' })

    // evento realtime leva quem/quando
    const excluidaCall = emitirEventoEmpresaConversa.mock.calls.find((c) => c[3] === 'mensagem_excluida')
    expect(excluidaCall).toBeTruthy()
    expect(excluidaCall[4]).toMatchObject({
      conversa_id: 10,
      mensagem_id: 42,
      apagada_por_usuario_id: 2,
      apagada_por_nome: 'Maria',
    })
  })

  test('se o WhatsApp não confirmar a remoção, não marca como apagada (502)', async () => {
    mockProvider.deleteMessage.mockResolvedValueOnce(false)
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversa, error: null })
      .mockResolvedValueOnce({ data: msgRow(), error: null })

    const res = buildRes()
    await excluirMensagem(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    // nenhum update de exclusão deve ter ocorrido
    const marked = chain.update.mock.calls.map((c) => c[0]).find((p) => p && p.apagada_para_todos === true)
    expect(marked).toBeFalsy()
  })
})
