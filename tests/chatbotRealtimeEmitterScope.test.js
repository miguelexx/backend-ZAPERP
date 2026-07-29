const mockEmitToVisibleUsers = jest.fn()

jest.mock('../controllers/chatController', () => ({
  emitirParaUsuariosQuePodemVerConversa: (...args) => mockEmitToVisibleUsers(...args),
}))

const { emitBotMensagemRealtime } = require('../helpers/chatbotRealtimeEmitter')

function createIo() {
  const emissions = []
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          emissions.push({ room, event, payload })
        },
      }
    },
  }
  return { io, emissions }
}

function createSupabase() {
  const result = {
    data: {
      id: 10,
      ultima_atividade: '2026-07-29T12:00:00.000Z',
      nome_contato_cache: 'Cliente',
      foto_perfil_contato_cache: null,
      telefone: '5511999999999',
      cliente_id: 20,
      departamento_id: 7,
      status_atendimento: 'em_atendimento',
      atendente_id: 5,
      tipo: 'individual',
    },
  }
  const chain = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => result),
  }
  return { from: jest.fn(() => chain) }
}

beforeEach(() => {
  mockEmitToVisibleUsers.mockReset()
  mockEmitToVisibleUsers.mockImplementation(async (io, _companyId, _conversationId, event, payload) => {
    io.to('usuario_5').emit(event, payload)
    return true
  })
})

test('conteúdo do chatbot é emitido apenas para usuários autorizados, nunca para empresa inteira', async () => {
  const { io, emissions } = createIo()
  await emitBotMensagemRealtime({
    io,
    supabase: createSupabase(),
    company_id: 1,
    conversa_id: 10,
    mensagem: {
      id: 99,
      conversa_id: 10,
      texto: 'conteúdo privado',
      direcao: 'out',
      status: 'sent',
      criado_em: '2026-07-29T12:00:00.000Z',
    },
  })

  expect(mockEmitToVisibleUsers).toHaveBeenCalledTimes(2)
  expect(emissions).toEqual(expect.arrayContaining([
    expect.objectContaining({ room: 'usuario_5', event: 'nova_mensagem' }),
    expect.objectContaining({ room: 'usuario_5', event: 'conversa_atualizada' }),
    expect.objectContaining({ room: 'empresa_1', event: 'atualizar_conversa' }),
  ]))
  expect(emissions.some((x) =>
    x.room === 'empresa_1' && ['nova_mensagem', 'conversa_atualizada', 'mensagem_editada'].includes(x.event)
  )).toBe(false)
})

test('falha ao resolver visibilidade usa somente a room autorizada da conversa', async () => {
  mockEmitToVisibleUsers.mockRejectedValue(new Error('db indisponivel'))
  const { io, emissions } = createIo()

  await emitBotMensagemRealtime({
    io,
    supabase: createSupabase(),
    company_id: 1,
    conversa_id: 10,
    mensagem: {
      id: 100,
      conversa_id: 10,
      texto: 'conteúdo privado',
      direcao: 'out',
      status: 'sent',
      criado_em: '2026-07-29T12:00:00.000Z',
    },
  })

  expect(emissions).toEqual(expect.arrayContaining([
    expect.objectContaining({ room: 'conversa_10', event: 'nova_mensagem' }),
    expect.objectContaining({ room: 'conversa_10', event: 'conversa_atualizada' }),
  ]))
  expect(emissions.some((x) =>
    x.room === 'empresa_1' && ['nova_mensagem', 'conversa_atualizada', 'mensagem_editada'].includes(x.event)
  )).toBe(false)
})
