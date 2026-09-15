jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  usuarioParticipaAtivamenteDaConversa: jest.fn().mockResolvedValue(false),
}))
jest.mock('../helpers/empresaModoSimplesFlag', () => ({ empresaModoSimplesAtivo: jest.fn().mockResolvedValue(false) }))
jest.mock('../services/chat/unread/conversationUnreadService', () => ({ marcarComoLidaPorUsuario: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/chat/read/conversationLookups', () => ({ loadWhatsappInstanceMetaMap: jest.fn().mockResolvedValue(new Map()) }))
jest.mock('../services/chat/presentation/messageAuthorEnrichment', () => ({ enrichMensagensComAutorUsuario: jest.fn(async (_, __, rows) => rows) }))
jest.mock('../helpers/reabertaFaltaInteracaoHelper', () => ({ resolveReabertaPorFaltaInteracao: () => false, enrichConversasReabertaFaltaInteracao: jest.fn() }))

const supabase = require('../config/supabase')
const { usuarioParticipaAtivamenteDaConversa } = require('../services/chat/access/conversationVisibilityService')
const { detalharChat } = require('../controllers/chat/conversationDetailController')
const { adicionarTagConversa, removerTagConversa } = require('../controllers/chat/tagsController')

const request = () => ({ params: { id: 10, tag_id: 7 }, body: { tag_id: 7 }, query: { limit: 2 },
  user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [3] }, app: { get: () => null } })
const response = () => { const res = {}; res.status = jest.fn(() => res); res.json = jest.fn(() => res); return res }
let queries, results
beforeEach(() => {
  jest.clearAllMocks()
  usuarioParticipaAtivamenteDaConversa.mockResolvedValue(false)
  results = {}; queries = []
  supabase.from.mockImplementation((table) => {
    const q = { table }
    for (const method of ['select', 'eq', 'order', 'limit', 'or', 'lt', 'update', 'insert', 'delete']) q[method] = jest.fn(() => q)
    const run = () => Promise.resolve((results[table] || []).shift() || { data: [], error: null })
    q.single = jest.fn(run); q.maybeSingle = jest.fn(run); q.then = (ok, fail) => run().then(ok, fail)
    queries.push(q); return q
  })
})

test.each([adicionarTagConversa, removerTagConversa])('etiquetas negam conversa de outra empresa antes de escrever', async (handler) => {
  results.conversas = [{ data: null, error: null }]
  const res = response(); await handler(request(), res)
  expect(res.status).toHaveBeenCalledWith(404)
  expect(queries.map(q => q.table)).toEqual(['conversas'])
  expect(queries[0].eq).toHaveBeenCalledWith('company_id', 1)
})

test('etiqueta de outra empresa não pode ser vinculada nem exposta', async () => {
  results.conversas = [{ data: { id: 10, atendente_id: 2 }, error: null }]
  results.tags = [{ data: null, error: null }]
  const res = response(); await adicionarTagConversa(request(), res)
  expect(res.status).toHaveBeenCalledWith(404)
  expect(queries.find(q => q.table === 'tags').eq).toHaveBeenCalledWith('company_id', 1)
  expect(queries.some(q => q.insert.mock.calls.length)).toBe(false)
})

test('etiquetas preservam contrato de sucesso e conflito simultâneo', async () => {
  for (const error of [null, { code: '23505' }]) {
    results.conversas = [{ data: { id: 10, atendente_id: 2 } }]
    results.tags = [{ data: { id: 7 } }]
    results.conversa_tags = [{ data: null }, { data: { tags: { id: 7, nome: 'Cliente' } }, error }]
    const res = response(); await adicionarTagConversa(request(), res)
    if (error) expect(res.status).toHaveBeenCalledWith(409)
    else expect(res.json).toHaveBeenCalledWith({ success: true, tag: { id: 7, nome: 'Cliente' } })
  }
})

test('detalhe inexistente retorna 404', async () => {
  results.conversas = [{ data: null, error: null }]
  const res = response(); await detalharChat(request(), res)
  expect(res.status).toHaveBeenCalledWith(404)
})

test.each([true, false])('co-atendente de outro setor: participante=%s', async (participante) => {
  usuarioParticipaAtivamenteDaConversa.mockResolvedValue(participante)
  results.conversas = [{ data: { id: 10, atendente_id: 9, departamento_id: 99, status_atendimento: 'em_atendimento', telefone: '5511999999999' } }]
  results.atendimentos = [{ data: null }]
  results.mensagens = [{ data: [] }]
  const res = response(); await detalharChat(request(), res)
  if (participante) {
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 10, mensagens_bloqueadas: undefined }))
  } else expect(res.status).toHaveBeenCalledWith(403)
})

test('atendente nao detalha conversa do mesmo setor assumida por outro', async () => {
  usuarioParticipaAtivamenteDaConversa.mockResolvedValue(false)
  results.conversas = [{ data: { id: 10, atendente_id: 9, departamento_id: 3, status_atendimento: 'em_atendimento', telefone: '5511999999999' } }]
  results.atendimentos = [{ data: null }]
  const res = response(); await detalharChat(request(), res)
  expect(res.status).toHaveBeenCalledWith(403)
  expect(res.json).toHaveBeenCalledWith({ error: 'Conversa assumida por outro atendente' })
})

test('página de movimentações legadas mantém cursor para mensagens anteriores', async () => {
  results.conversas = [{ data: { id: 10, atendente_id: 2, status_atendimento: 'em_atendimento', telefone: '5511999999999' } }]
  results.mensagens = [{ data: [3, 2, 1].map(id => ({ id, conversa_id: 10, criado_em: `2026-09-08T12:00:0${id}Z`, texto: 'Movimentação interna' })) }]
  const res = response(); await detalharChat(request(), res)
  expect(res.status).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mensagens: [], next_cursor_id: 2, next_cursor: expect.any(String) }))
})
