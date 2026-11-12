/**
 * Guarda idempotente do encerramento MANUAL (doc 40 §3.2, decidido em 11/11/2026).
 *
 * Antes, `encerrarChat` fazia UPDATE sem filtrar o status atual: duplo clique em "Finalizar"
 * (ou duas abas) = 2 UPDATEs bem-sucedidos → 2 registros "encerrou" → 2 mensagens de
 * finalização ao cliente. Agora:
 *   - conversa já fechada na checagem de permissão → 200 `{ ok, ja_encerrada }`, SEM UPDATE,
 *     SEM registrarAtendimento e SEM mensagem de finalização;
 *   - UPDATE condicionado ao status visto na checagem (`.eq`, ou `.is(null)` quando não há status);
 *   - status mudou no meio-tempo: para FECHADA → 200 idempotente; para outro estado aberto → 409
 *     (o encerramento não aconteceu).
 * Cada caso foi conferido a falhar com a mutação correspondente (guarda removida; 409 no lugar
 * do 200 idempotente; `.eq(null)` em vez de `.is`).
 */

jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/atendimentosRegistroService', () => ({ registrarAtendimento: jest.fn() }))
jest.mock('../services/chatbotTriageService', () => ({
  resetOpcaoInvalidaLimitForConversa: jest.fn().mockResolvedValue(undefined),
  getChatbotConfig: jest.fn().mockResolvedValue({ enviarMensagemFinalizacao: true, mensagemFinalizacao: 'Obrigado, protocolo {protocolo}' }),
  buildMensagemFinalizacao: jest.fn(() => 'Obrigado, protocolo 55'),
}))
jest.mock('../controllers/webhookInbound/recentClosedConversationGuard', () => ({
  rememberClosedConversation: jest.fn(),
}))

const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { registrarAtendimento } = require('../services/atendimentosRegistroService')
const { encerrarChat } = require('../controllers/chat/attendanceController')

const ABERTA = { id: 10, status_atendimento: 'em_atendimento', tipo: 'cliente', telefone: '5534999999999' }
const FECHADA = { ...ABERTA, status_atendimento: 'fechada' }

let updates
let filtros
let updateResult
let selectResult
let inserts

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
  filtros = []
  inserts = []
  updateResult = { data: FECHADA, error: null }
  selectResult = { data: ABERTA, error: null }
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: ABERTA })
  registrarAtendimento.mockResolvedValue({ error: null, atendimento: { id: 55 } })

  supabase.from.mockImplementation((table) => {
    const state = { op: 'select', patch: null }
    const q = {}
    for (const method of ['select', 'neq', 'in', 'order', 'limit']) q[method] = jest.fn(() => q)
    q.eq = jest.fn((campo, valor) => { filtros.push({ table, op: state.op, tipo: 'eq', campo, valor }); return q })
    q.is = jest.fn((campo, valor) => { filtros.push({ table, op: state.op, tipo: 'is', campo, valor }); return q })
    q.update = jest.fn((patch) => { state.op = 'update'; state.patch = patch; updates.push({ table, patch }); return q })
    q.insert = jest.fn((row) => { state.op = 'insert'; inserts.push({ table, row }); return q })
    const run = () => {
      if (table === 'conversas' && state.op === 'update' && state.patch?.status_atendimento === 'fechada') {
        return Promise.resolve(updateResult)
      }
      if (table === 'conversas' && state.op === 'select') return Promise.resolve(selectResult)
      if (state.op === 'insert') return Promise.resolve({ data: { id: 900, ...inserts[inserts.length - 1].row }, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    q.single = run
    q.maybeSingle = run
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

const fechamentos = () => updates.filter((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')

test('caminho feliz: UPDATE condicionado ao status visto na checagem de permissão', async () => {
  const res = response()
  await encerrarChat(req(), res)

  expect(res.status).not.toHaveBeenCalledWith(500)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  expect(fechamentos()).toHaveLength(1)
  const guarda = filtros.find((f) => f.table === 'conversas' && f.op === 'update' && f.campo === 'status_atendimento')
  expect(guarda).toEqual(expect.objectContaining({ tipo: 'eq', valor: 'em_atendimento' }))
  expect(registrarAtendimento).toHaveBeenCalledTimes(1)
})

test('conversa já fechada na checagem: 200 idempotente, sem UPDATE, sem atendimento, sem mensagem', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: FECHADA })
  selectResult = { data: FECHADA, error: null }
  const res = response()
  await encerrarChat(req(), res)

  expect(res.status).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, ja_encerrada: true, conversa: expect.objectContaining({ id: 10 }) }))
  expect(fechamentos()).toHaveLength(0)
  expect(registrarAtendimento).not.toHaveBeenCalled()
  expect(inserts.filter((i) => i.table === 'mensagens')).toHaveLength(0)
})

test('status mudou para FECHADA entre a checagem e o UPDATE (outra aba fechou): 200 idempotente', async () => {
  updateResult = { data: null, error: null } // ninguém casou
  selectResult = { data: FECHADA, error: null }
  const res = response()
  await encerrarChat(req(), res)

  expect(res.status).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, ja_encerrada: true }))
  expect(registrarAtendimento).not.toHaveBeenCalled()
  expect(inserts.filter((i) => i.table === 'mensagens')).toHaveLength(0)
})

test('status mudou para outro estado ABERTO (transferência simultânea): 409, nada registrado', async () => {
  updateResult = { data: null, error: null }
  selectResult = { data: { ...ABERTA, status_atendimento: 'aberta' }, error: null }
  const res = response()
  await encerrarChat(req(), res)

  expect(res.status).toHaveBeenCalledWith(409)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONVERSA_MUDOU_DE_ESTADO' }))
  expect(registrarAtendimento).not.toHaveBeenCalled()
})

test('conversa sem status usa .is(null) na guarda (NOT IN/eq(null) nunca casaria)', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...ABERTA, status_atendimento: null } })
  const res = response()
  await encerrarChat(req(), res)

  const guarda = filtros.find((f) => f.table === 'conversas' && f.op === 'update' && f.campo === 'status_atendimento')
  expect(guarda).toEqual(expect.objectContaining({ tipo: 'is', valor: null }))
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
})

test('fallback de coluna ausente mantém a guarda nas duas tentativas', async () => {
  let chamadas = 0
  const results = [
    { data: null, error: { message: "Could not find the 'pagamento_prazo_ate' column of 'conversas' in the schema cache" } },
    { data: FECHADA, error: null },
  ]
  supabase.from.mockImplementation((table) => {
    const state = { op: 'select', patch: null }
    const q = {}
    for (const method of ['select', 'neq', 'in', 'order', 'limit']) q[method] = jest.fn(() => q)
    q.eq = jest.fn((campo, valor) => { filtros.push({ table, op: state.op, tipo: 'eq', campo, valor }); return q })
    q.is = jest.fn(() => q)
    q.update = jest.fn((patch) => { state.op = 'update'; state.patch = patch; updates.push({ table, patch }); return q })
    q.insert = jest.fn(() => q)
    const run = () => {
      if (table === 'conversas' && state.op === 'update' && state.patch?.status_atendimento === 'fechada') {
        return Promise.resolve(results[chamadas++] || { data: null, error: null })
      }
      if (table === 'conversas' && state.op === 'select') return Promise.resolve({ data: ABERTA, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    q.single = run
    q.maybeSingle = run
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
  const res = response()
  await encerrarChat(req(), res)

  expect(res.status).not.toHaveBeenCalledWith(500)
  expect(fechamentos()).toHaveLength(2)
  const guardas = filtros.filter((f) => f.table === 'conversas' && f.op === 'update' && f.campo === 'status_atendimento')
  expect(guardas).toHaveLength(2)
})
