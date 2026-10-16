/**
 * Garantias do encerramento MANUAL (POST /chats/:id/encerrar).
 *
 * Regressões cobertas:
 *  - falha ao registrar o histórico do atendimento devolvia 500 DEPOIS da conversa já estar
 *    fechada: o frontend revertia o card para "Em atendimento" e ninguém recebia o realtime;
 *  - coluna opcional ausente (instalação sem os módulos de pagamento/falta de interação)
 *    derrubava o UPDATE inteiro e a conversa simplesmente não fechava.
 */

jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/atendimentosRegistroService', () => ({ registrarAtendimento: jest.fn() }))
jest.mock('../services/chatbotTriageService', () => ({
  resetOpcaoInvalidaLimitForConversa: jest.fn().mockResolvedValue(undefined),
  getChatbotConfig: jest.fn().mockResolvedValue(null),
  buildMensagemFinalizacao: jest.fn(() => ''),
}))
jest.mock('../controllers/webhookInbound/recentClosedConversationGuard', () => ({
  rememberClosedConversation: jest.fn(),
}))

const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { registrarAtendimento } = require('../services/atendimentosRegistroService')
const { encerrarChat } = require('../controllers/chat/attendanceController')

const CONVERSA = { id: 10, status_atendimento: 'em_atendimento', tipo: 'cliente', telefone: '5534999999999' }

let conversaUpdateResults
let updates

const req = () => ({
  user: { id: 2, company_id: 1, perfil: 'atendente', departamento_ids: [] },
  params: { id: 10 },
  app: { get: () => null },
})
const response = () => {
  const r = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}

beforeEach(() => {
  jest.clearAllMocks()
  updates = []
  conversaUpdateResults = [{ data: { ...CONVERSA, status_atendimento: 'fechada' }, error: null }]
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: CONVERSA })
  registrarAtendimento.mockResolvedValue({ error: null, atendimento: { id: 55 } })

  supabase.from.mockImplementation((table) => {
    const state = { patch: null }
    const q = {}
    for (const method of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit']) q[method] = jest.fn(() => q)
    q.update = jest.fn((patch) => {
      state.patch = patch
      updates.push({ table, patch })
      return q
    })
    q.insert = jest.fn(() => q)
    const run = () => {
      if (table === 'conversas' && state.patch && state.patch.status_atendimento === 'fechada') {
        return Promise.resolve(conversaUpdateResults.shift() || { data: null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }
    q.single = run
    q.maybeSingle = run
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

test('conversa fecha e responde ok no caminho feliz', async () => {
  const res = response()
  await encerrarChat(req(), res)
  expect(res.status).not.toHaveBeenCalledWith(500)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
})

test('falha ao registrar o histórico não transforma encerramento concluído em erro', async () => {
  registrarAtendimento.mockResolvedValue({ error: { message: 'insert falhou' }, atendimento: null })
  const res = response()
  await encerrarChat(req(), res)
  expect(res.status).not.toHaveBeenCalledWith(500)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  expect(updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')).toBe(true)
})

test('coluna opcional ausente cai no patch base e a conversa fecha mesmo assim', async () => {
  conversaUpdateResults = [
    { data: null, error: { message: "Could not find the 'pagamento_prazo_ate' column of 'conversas' in the schema cache" } },
    { data: { ...CONVERSA, status_atendimento: 'fechada' }, error: null },
  ]
  const res = response()
  await encerrarChat(req(), res)
  expect(res.status).not.toHaveBeenCalledWith(500)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  const fechamentos = updates.filter((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')
  expect(fechamentos).toHaveLength(2)
  expect(fechamentos[1].patch).not.toHaveProperty('pagamento_prazo_ate')
  expect(fechamentos[1].patch).not.toHaveProperty('reaberta_falta_interacao_em')
})

test('erro real do banco continua sendo 500 (conversa não fechou)', async () => {
  conversaUpdateResults = [{ data: null, error: { message: 'connection reset' } }]
  const res = response()
  await encerrarChat(req(), res)
  expect(res.status).toHaveBeenCalledWith(500)
})

test('grupo não é encerrável', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...CONVERSA, tipo: 'grupo' } })
  const res = response()
  await encerrarChat(req(), res)
  expect(res.status).toHaveBeenCalledWith(400)
  expect(updates).toHaveLength(0)
})
