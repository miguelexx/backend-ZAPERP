jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  usuarioParticipaAtivamenteDaConversa: jest.fn(),
  getConversaParticipanteIdsAtivos: jest.fn(),
  invalidateConversaVisibilityCache: jest.fn(),
}))
jest.mock('../services/atendimentosRegistroService', () => ({ registrarAtendimento: jest.fn().mockResolvedValue({}) }))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirConversaAtualizada: jest.fn(),
  emitirParaUsuariosQuePodemVerConversa: jest.fn().mockResolvedValue(true),
  emitirEventoEmpresaConversa: jest.fn(),
  emitirSincronizacaoListaConversas: jest.fn(),
  emitirLock: jest.fn(),
  emitirRealtimeAposAssumir: jest.fn(),
  emitirParaUsuario: jest.fn(),
  emitirMovimentacaoInternaAtendimento: jest.fn(),
  emitirDepartamento: jest.fn(),
}))
const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const visibility = require('../services/chat/access/conversationVisibilityService')
const gateway = require('../services/chat/realtime/chatRealtimeGateway')
const { removerAtendenteConversa, adicionarAtendenteConversa } = require('../controllers/chat/attendanceController')

// Conversa 10: responsável = 9; co-atendente 5 foi incluído por 7.
const conv = { id: 10, atendente_id: 9, status_atendimento: 'em_atendimento' }
let updates
const io = {}
const req = ({ userId, perfil = 'atendente', alvo = 5 }) => ({
  user: { id: userId, company_id: 1, perfil },
  params: { id: 10, usuario_id: alvo },
  body: { usuario_id: alvo },
  app: { get: () => io },
})
const response = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r }

beforeEach(() => {
  jest.clearAllMocks(); updates = []
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv })
  visibility.usuarioParticipaAtivamenteDaConversa.mockResolvedValue(false)
  visibility.getConversaParticipanteIdsAtivos.mockResolvedValue([])
  supabase.from.mockImplementation((table) => {
    const q = {}
    for (const m of ['select', 'eq', 'in', 'order']) q[m] = jest.fn(() => q)
    q.update = jest.fn((row) => { updates.push({ table, row }); return q })
    q.insert = jest.fn(() => q)
    const run = () => Promise.resolve(table === 'usuarios'
      ? { data: { id: 5, nome: 'Fulano', perfil: 'atendente', ativo: true } }
      : { data: { id: 33, adicionado_por: 7, ativo: true }, error: null })
    q.single = run; q.maybeSingle = run; q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

test('atendente que só vê a conversa NÃO remove co-atendente alheio', async () => {
  const res = response(); await removerAtendenteConversa(req({ userId: 2 }), res)
  expect(res.status).toHaveBeenCalledWith(403)
  expect(updates).toEqual([])
})

test.each([
  ['responsável principal', { userId: 9 }],
  ['quem incluiu o co-atendente', { userId: 7 }],
  ['o próprio co-atendente (sair)', { userId: 5 }],
  ['admin', { userId: 2, perfil: 'admin' }],
  ['supervisor', { userId: 2, perfil: 'supervisor' }],
])('%s pode remover', async (_label, args) => {
  const res = response(); await removerAtendenteConversa(req(args), res)
  expect(res.status).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith({ ok: true })
  expect(updates).toHaveLength(1)
})

test('responsável principal nunca é removido (usa Transferir)', async () => {
  const res = response(); await removerAtendenteConversa(req({ userId: 9, alvo: 9 }), res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(updates).toEqual([])
})

test('remover avisa todos que veem a conversa (não só o removido)', async () => {
  const res = response(); await removerAtendenteConversa(req({ userId: 9 }), res)
  const call = gateway.emitirParaUsuariosQuePodemVerConversa.mock.calls.find((c) => c[3] === 'conversa_participantes_atualizados')
  expect(call).toBeTruthy()
  expect(call[4]).toEqual({ conversa_id: 10, company_id: 1, motivo: 'removido' })
})

test('adicionar avisa todos que veem a conversa', async () => {
  const res = response(); await adicionarAtendenteConversa(req({ userId: 9, alvo: 5 }), res)
  expect(res.status).toHaveBeenCalledWith(201)
  const call = gateway.emitirParaUsuariosQuePodemVerConversa.mock.calls.find((c) => c[3] === 'conversa_participantes_atualizados')
  expect(call[4]).toEqual({ conversa_id: 10, company_id: 1, motivo: 'adicionado' })
})

test('falha do realtime não derruba a remoção já gravada', async () => {
  gateway.emitirParaUsuariosQuePodemVerConversa.mockRejectedValueOnce(new Error('cache fora'))
  const res = response(); await removerAtendenteConversa(req({ userId: 9 }), res)
  expect(res.json).toHaveBeenCalledWith({ ok: true })
})
