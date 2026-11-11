/**
 * `GET /chats/:id?lista=1` — modo leve para o refetch do CARD pelo socket.
 *
 * Sem o parâmetro, o endpoint é a abertura da thread: histórico paginado, marca como lida,
 * injeta movimentações internas, enriquece citações e dispara sync do contato em background.
 * O frontend chamava exatamente isso a cada `atualizar_conversa` — ou seja, a cada mensagem
 * recebida, para todo usuário visível: histórico inteiro baixado e, pior, a conversa marcada
 * como lida para quem nem tinha olhado (zerava o badge no servidor).
 *
 * O que este teste trava:
 *   - com `lista=1`: NÃO marca como lida, busca só 1 mensagem, NÃO injeta movimentações,
 *     NÃO enriquece citações, NÃO agenda sync em background, e ainda devolve o card
 *     (status, exibir_badge_aberta, sem_mensagens) com a última mensagem;
 *   - sem o parâmetro: comportamento de sempre (marca como lida, limit+1, movimentações);
 *   - as checagens de permissão continuam iguais (403 para conversa assumida por outro).
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
jest.mock('../services/ultramsgSyncContact', () => ({ syncConversationContactOnJoin: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/ultramsgGroupsSyncService', () => ({ syncConversationGroupOnJoin: jest.fn().mockResolvedValue(undefined) }))

const supabase = require('../config/supabase')
const { marcarComoLidaPorUsuario } = require('../services/chat/unread/conversationUnreadService')
const { listarMensagensInternasMovimentacao } = require('../services/atendimentosRegistroService')
const { enrichReplyMetaSnippets } = require('../services/chat/presentation/replyMetaSnippetEnrichment')
const { syncConversationContactOnJoin } = require('../services/ultramsgSyncContact')
const { detalharChat } = require('../controllers/chat/conversationDetailController')

const MENSAGENS_DESC = [
  { id: 30, conversa_id: 10, criado_em: '2026-11-09T12:00:00.000Z', direcao: 'in', texto: 'c' },
  { id: 20, conversa_id: 10, criado_em: '2026-11-08T09:30:00.000Z', direcao: 'in', texto: 'b' },
]

const response = () => {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

const io = { EVENTS: {}, to: jest.fn(() => ({ emit: jest.fn() })) }
const request = (query = {}, user = {}) => ({
  params: { id: 10 },
  query: { limit: 20, ...query },
  user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [], ...user },
  app: { get: (k) => (k === 'io' ? io : null) },
})

let results
let chamadas
beforeEach(() => {
  jest.clearAllMocks()
  chamadas = []
  results = {
    conversas: [{ data: { id: 10, company_id: 1, atendente_id: 2, telefone: '5511999999999', status_atendimento: 'em_atendimento', lida: false }, error: null }],
    mensagens: [{ data: [...MENSAGENS_DESC], error: null }],
    mensagens_ocultas: [{ data: [], error: null }],
  }
  supabase.from.mockImplementation((table) => {
    const q = { table, _limit: null }
    for (const m of ['select', 'eq', 'order', 'or', 'lt', 'lte', 'gte', 'in', 'is', 'not', 'update', 'insert', 'delete']) {
      q[m] = jest.fn(() => q)
    }
    q.limit = jest.fn((n) => { q._limit = n; return q })
    const run = () => {
      chamadas.push({ table, limit: q._limit })
      const r = (results[table] || []).shift() || { data: [], error: null }
      // Respeita o limit pedido (como o PostgREST faria)
      if (Array.isArray(r.data) && q._limit != null) return Promise.resolve({ ...r, data: r.data.slice(0, q._limit) })
      return Promise.resolve(r)
    }
    q.single = jest.fn(run)
    q.maybeSingle = jest.fn(run)
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

const flushImmediates = () => new Promise((r) => setImmediate(r))

test('lista=1: não marca como lida, busca 1 mensagem, sem movimentações/citações/sync — e devolve o card', async () => {
  const res = response()
  await detalharChat(request({ lista: '1' }), res)
  await flushImmediates()

  expect(res.status).not.toHaveBeenCalled()
  expect(marcarComoLidaPorUsuario).not.toHaveBeenCalled()
  expect(listarMensagensInternasMovimentacao).not.toHaveBeenCalled()
  expect(enrichReplyMetaSnippets).not.toHaveBeenCalled()
  expect(syncConversationContactOnJoin).not.toHaveBeenCalled()
  const msgQuery = chamadas.find((c) => c.table === 'mensagens')
  expect(msgQuery).toBeTruthy()
  expect(msgQuery.limit).toBe(1)
  expect(chamadas.some((c) => c.table === 'mensagens_ocultas')).toBe(false)

  const body = res.json.mock.calls[0][0]
  expect(body.id).toBe(10)
  expect(body.mensagens).toHaveLength(1)
  expect(body.mensagens[0].id).toBe(30)
  expect(body.sem_mensagens).toBe(false)
  expect(body.exibir_badge_aberta).toBe(true)
  expect(body.status_atendimento).toBe('em_atendimento')
  expect(body.next_cursor).toBeNull()
})

test('sem o parâmetro: comportamento de sempre (marca como lida, limit+1, movimentações, sync)', async () => {
  const res = response()
  await detalharChat(request(), res)
  await flushImmediates()

  expect(res.status).not.toHaveBeenCalled()
  expect(marcarComoLidaPorUsuario).toHaveBeenCalledTimes(1)
  expect(listarMensagensInternasMovimentacao).toHaveBeenCalledTimes(1)
  expect(enrichReplyMetaSnippets).toHaveBeenCalledTimes(1)
  expect(syncConversationContactOnJoin).toHaveBeenCalledTimes(1)
  const msgQuery = chamadas.find((c) => c.table === 'mensagens')
  expect(msgQuery.limit).toBe(21)
  const body = res.json.mock.calls[0][0]
  expect(body.mensagens).toHaveLength(2)
})

test('lista=1 mantém as permissões: atendente sem acesso a conversa assumida por outro leva 403', async () => {
  results.conversas = [{ data: { id: 10, company_id: 1, atendente_id: 99, telefone: '5511999999999', status_atendimento: 'em_atendimento', departamento_id: 5 }, error: null }]
  results.atendimentos = [{ data: null, error: null }]
  const res = response()
  await detalharChat(request({ lista: '1' }, { departamento_ids: [5] }), res)

  expect(res.status).toHaveBeenCalledWith(403)
  expect(marcarComoLidaPorUsuario).not.toHaveBeenCalled()
})
