/**
 * detalharChat injeta as bolhas internas de movimentação ("X assumiu", "X transferiu para Y",
 * com a observação) na janela de tempo da página de mensagens.
 *
 * Regressão coberta aqui: `mensagens.reverse()` muta o array, então as pontas eram lidas
 * trocadas e a janela saía invertida (`from` = mensagem mais NOVA e, com cursor, `to` = mais
 * ANTIGA — intervalo impossível). Na prática o registro da transferência não aparecia no
 * histórico de admin/supervisor.
 */
jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  usuarioParticipaAtivamenteDaConversa: jest.fn().mockResolvedValue(false),
}))
jest.mock('../helpers/empresaModoSimplesFlag', () => ({ empresaModoSimplesAtivo: jest.fn().mockResolvedValue(false) }))
jest.mock('../services/chat/unread/conversationUnreadService', () => ({ marcarComoLidaPorUsuario: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/chat/read/conversationLookups', () => ({ loadWhatsappInstanceMetaMap: jest.fn().mockResolvedValue(new Map()) }))
jest.mock('../services/chat/presentation/messageAuthorEnrichment', () => ({ enrichMensagensComAutorUsuario: jest.fn(async (_, __, rows) => rows) }))
jest.mock('../services/chat/presentation/replyMetaSnippetEnrichment', () => ({ enrichReplyMetaSnippets: jest.fn(async (_, __, rows) => rows) }))
jest.mock('../helpers/reabertaFaltaInteracaoHelper', () => ({ resolveReabertaPorFaltaInteracao: () => false, enrichConversasReabertaFaltaInteracao: jest.fn() }))
jest.mock('../services/atendimentosRegistroService', () => ({
  listarMensagensInternasMovimentacao: jest.fn().mockResolvedValue([]),
  perfilPodeVerMovimentacaoInterna: jest.fn(() => true),
  isMensagemLegadaMovimentacaoInterna: jest.fn(() => false),
}))

const supabase = require('../config/supabase')
const { listarMensagensInternasMovimentacao } = require('../services/atendimentosRegistroService')
const { detalharChat } = require('../controllers/chat/conversationDetailController')

// Como vem do banco: ordem DESCENDENTE (mais nova primeiro)
const MENSAGENS_DESC = [
  { id: 30, conversa_id: 10, criado_em: '2026-11-09T12:00:00.000Z', direcao: 'out', texto: 'c' },
  { id: 20, conversa_id: 10, criado_em: '2026-11-08T09:30:00.000Z', direcao: 'in', texto: 'b' },
  { id: 10, conversa_id: 10, criado_em: '2026-11-07T08:00:00.000Z', direcao: 'in', texto: 'a' },
]
const MAIS_NOVA = '2026-11-09T12:00:00.000Z'
const MAIS_ANTIGA = '2026-11-07T08:00:00.000Z'

const response = () => {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

const request = (query = {}) => ({
  params: { id: 10 },
  query: { limit: 10, ...query },
  user: { company_id: 1, id: 2, perfil: 'admin', departamento_ids: [] },
  app: { get: () => null },
})

let results
beforeEach(() => {
  jest.clearAllMocks()
  listarMensagensInternasMovimentacao.mockResolvedValue([])
  results = {
    conversas: [{ data: { id: 10, company_id: 1, atendente_id: 2, telefone: '5511999999999', status_atendimento: 'em_atendimento' }, error: null }],
    mensagens: [{ data: [...MENSAGENS_DESC], error: null }],
    mensagens_ocultas: [{ data: [], error: null }],
  }
  supabase.from.mockImplementation((table) => {
    const q = { table }
    for (const m of ['select', 'eq', 'order', 'limit', 'or', 'lt', 'lte', 'gte', 'in', 'is', 'not', 'update', 'insert', 'delete']) {
      q[m] = jest.fn(() => q)
    }
    const run = () => Promise.resolve((results[table] || []).shift() || { data: [], error: null })
    q.single = jest.fn(run)
    q.maybeSingle = jest.fn(run)
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

test('primeira página: janela começa na mensagem mais ANTIGA da página', async () => {
  const res = response()
  await detalharChat(request(), res)

  expect(res.status).not.toHaveBeenCalled()
  expect(listarMensagensInternasMovimentacao).toHaveBeenCalledTimes(1)
  const args = listarMensagensInternasMovimentacao.mock.calls[0][0]
  expect(args.from_criado_em).toBe(MAIS_ANTIGA)
  expect(args.to_criado_em).toBeUndefined()
})

test('página antiga (com cursor): janela vai da mais antiga até a mais nova da página', async () => {
  const res = response()
  await detalharChat(request({ cursor: '2026-11-10T00:00:00.000Z', cursor_id: 99 }), res)

  expect(res.status).not.toHaveBeenCalled()
  const args = listarMensagensInternasMovimentacao.mock.calls[0][0]
  expect(args.from_criado_em).toBe(MAIS_ANTIGA)
  expect(args.to_criado_em).toBe(MAIS_NOVA)
  expect(new Date(args.from_criado_em).getTime()).toBeLessThanOrEqual(new Date(args.to_criado_em).getTime())
})

test('a thread sai em ordem crescente e as mensagens do banco não são mutadas', async () => {
  const res = response()
  await detalharChat(request(), res)

  const payload = res.json.mock.calls[0][0]
  const ids = payload.mensagens.map((m) => m.id)
  expect(ids).toEqual([10, 20, 30])
})
