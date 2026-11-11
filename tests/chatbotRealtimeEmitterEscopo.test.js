/**
 * `emitBotMensagemRealtime` (resposta do chatbot) escopado a quem pode ver a conversa.
 *
 * Antes ia para `empresa_` inteira: cada usuário que NÃO tinha a conversa na lista fazia
 * `GET /chats/:id` por causa do `nova_mensagem` e levava 403 — uma tempestade de detalhes por
 * mensagem de triagem (doc 40 §3.1). Agora usa o mesmo caminho escopado do inbound e só cai
 * nas rooms amplas quando não dá para resolver os destinatários.
 *
 * O que este teste trava:
 *   - com destinatários resolvidos: os 3 eventos saem pelo emit escopado e NADA vai para `empresa_`;
 *   - `atualizar_conversa` leva `motivo: 'nova_mensagem'` (o frontend novo não refaz o GET);
 *   - sem destinatários (false) ou com erro: cai nas rooms amplas de antes, com o mesmo motivo.
 */
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirParaUsuariosQuePodemVerConversa: jest.fn(),
}))

const { emitirParaUsuariosQuePodemVerConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const { emitBotMensagemRealtime } = require('../helpers/chatbotRealtimeEmitter')

function fakeIo() {
  const emits = []
  const io = {
    to: jest.fn((rooms) => ({
      emit: (event, payload) => emits.push({ rooms: Array.isArray(rooms) ? rooms : [rooms], event, payload }),
    })),
  }
  return { io, emits }
}

function fakeSupabase(convRow) {
  const q = {}
  for (const m of ['select', 'eq']) q[m] = jest.fn(() => q)
  q.maybeSingle = jest.fn(async () => ({ data: convRow, error: null }))
  return { from: jest.fn(() => q) }
}

const mensagem = { id: 77, conversa_id: 10, texto: 'Olá! Escolha o setor', criado_em: '2026-11-10T12:00:00.000Z', status: 'sent', direcao: 'out' }
const convRow = { id: 10, departamento_id: 3, status_atendimento: 'aberta', atendente_id: null, telefone: '5511999999999', tipo: 'contato' }

beforeEach(() => jest.clearAllMocks())

test('com destinatários resolvidos: tudo escopado, nada para empresa_', async () => {
  emitirParaUsuariosQuePodemVerConversa.mockResolvedValue(true)
  const { io, emits } = fakeIo()

  await emitBotMensagemRealtime({ io, supabase: fakeSupabase(convRow), company_id: 1, conversa_id: 10, mensagem })

  const eventos = emitirParaUsuariosQuePodemVerConversa.mock.calls.map((c) => c[3])
  expect(eventos).toEqual(['nova_mensagem', 'atualizar_conversa', 'conversa_atualizada'])
  for (const c of emitirParaUsuariosQuePodemVerConversa.mock.calls) {
    expect(c[1]).toBe(1)
    expect(c[2]).toBe(10)
  }
  const atualizar = emitirParaUsuariosQuePodemVerConversa.mock.calls.find((c) => c[3] === 'atualizar_conversa')
  expect(atualizar[4]).toEqual({ id: 10, motivo: 'nova_mensagem' })
  const convPayload = emitirParaUsuariosQuePodemVerConversa.mock.calls.find((c) => c[3] === 'conversa_atualizada')[4]
  expect(convPayload).toEqual(expect.objectContaining({ id: 10, departamento_id: 3, ultima_mensagem_preview: expect.objectContaining({ fromMe: true }) }))
  expect(emits).toHaveLength(0)
  expect(io.to).not.toHaveBeenCalled()
})

test('sem destinatários: fallback para as rooms amplas de antes, com o motivo', async () => {
  emitirParaUsuariosQuePodemVerConversa.mockResolvedValue(false)
  const { io, emits } = fakeIo()

  await emitBotMensagemRealtime({ io, supabase: fakeSupabase(convRow), company_id: 1, conversa_id: 10, mensagem })

  const porEvento = Object.fromEntries(emits.map((e) => [e.event, e]))
  expect(porEvento.nova_mensagem.rooms).toEqual(['conversa_10', 'empresa_1', 'departamento_3'])
  expect(porEvento.atualizar_conversa.rooms).toEqual(['empresa_1', 'departamento_3'])
  expect(porEvento.atualizar_conversa.payload).toEqual({ id: 10, motivo: 'nova_mensagem' })
  expect(porEvento.conversa_atualizada.rooms).toEqual(['conversa_10', 'empresa_1', 'departamento_3'])
})

test('erro ao resolver destinatários não derruba o emit: cai no fallback', async () => {
  emitirParaUsuariosQuePodemVerConversa.mockRejectedValue(new Error('cache indisponível'))
  const { io, emits } = fakeIo()
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

  await emitBotMensagemRealtime({ io, supabase: fakeSupabase(convRow), company_id: 1, conversa_id: 10, mensagem })

  expect(emits.map((e) => e.event)).toEqual(['nova_mensagem', 'atualizar_conversa', 'conversa_atualizada'])
  warn.mockRestore()
})
