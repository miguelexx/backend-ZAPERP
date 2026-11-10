/**
 * A bolha interna "X transferiu para Y" é visível para admin/administrador/supervisor
 * (MOVIMENTACAO_INTERNA_PERFIS, usada pelo detalharChat). O emit em tempo real pré-filtrava
 * os destinatários só por 'admin'/'administrador', então o supervisor só via a movimentação
 * ao reabrir a conversa. Este teste tranca os dois lados: supervisor recebe, atendente não.
 */
const supabase = require('../config/supabase')
const { emitirMovimentacaoInternaAtendimento } = require('../services/chat/realtime/chatRealtimeGateway')
const { MOVIMENTACAO_INTERNA_PERFIS } = require('../services/atendimentosRegistroService')

const atendimento = {
  id: 123,
  company_id: 7,
  conversa_id: 42,
  acao: 'transferiu',
  de_usuario_id: 10,
  para_usuario_id: 20,
  criado_em: '2026-11-09T12:00:00.000Z',
}

let results
let perfisConsultados

function mockSupabase() {
  perfisConsultados = []
  supabase.from.mockImplementation((table) => {
    const q = { table }
    for (const method of ['select', 'eq', 'order', 'limit', 'or', 'update', 'insert', 'delete']) {
      q[method] = jest.fn(() => q)
    }
    q.in = jest.fn((column, values) => {
      if (column === 'perfil') perfisConsultados.push(values)
      return q
    })
    const run = () => Promise.resolve((results[table] || []).shift() || { data: [], error: null })
    q.single = jest.fn(run)
    q.maybeSingle = jest.fn(run)
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
}

function ioMock() {
  const rooms = []
  return {
    rooms,
    to: jest.fn((room) => ({ emit: jest.fn((evento, payload) => rooms.push({ room, evento, payload })) })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  results = {
    usuarios: [
      // 1ª consulta: nomes de quem transferiu / quem recebeu
      { data: [{ id: 10, nome: 'Ana' }, { id: 20, nome: 'Bruno' }], error: null },
      // 2ª consulta: destinatários do realtime
      {
        data: [
          { id: 1, perfil: 'admin' },
          { id: 5, perfil: 'supervisor' },
          { id: 9, perfil: 'atendente' },
        ],
        error: null,
      },
    ],
  }
  mockSupabase()
})

test('supervisor recebe a movimentação interna em tempo real (e atendente não)', async () => {
  const io = ioMock()
  await emitirMovimentacaoInternaAtendimento(io, { company_id: 7, conversa: { id: 42 }, atendimento })

  const salas = io.rooms.map((r) => r.room)
  expect(salas).toContain('usuario_1')
  expect(salas).toContain('usuario_5')
  expect(salas).not.toContain('usuario_9')
  expect(io.rooms[0].evento).toBe('mensagem_interna_atendimento')
  expect(io.rooms[0].payload.movimentacao_interna.acao).toBe('transferiu')
})

test('o pré-filtro de perfis no banco usa a lista canônica', async () => {
  const io = ioMock()
  await emitirMovimentacaoInternaAtendimento(io, { company_id: 7, conversa: { id: 42 }, atendimento })

  expect(perfisConsultados).toHaveLength(1)
  expect(perfisConsultados[0]).toEqual(MOVIMENTACAO_INTERNA_PERFIS)
  expect(perfisConsultados[0]).toContain('supervisor')
})

test('sem atendimento (falha ao gravar histórico) não emite nem consulta usuários', async () => {
  const io = ioMock()
  await emitirMovimentacaoInternaAtendimento(io, { company_id: 7, conversa: { id: 42 }, atendimento: null })

  expect(io.to).not.toHaveBeenCalled()
  expect(supabase.from).not.toHaveBeenCalled()
})
