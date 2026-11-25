jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  usuarioParticipaAtivamenteDaConversa: jest.fn(),
  getConversaParticipanteIdsAtivos: jest.fn(),
  invalidateConversaVisibilityCache: jest.fn(),
  encerrarCoAtendimentoDaConversa: jest.fn().mockResolvedValue(0),
}))
// Trava de visão por número: padrão = ninguém travado (mapa vazio).
jest.mock('../services/chat/access/usuarioWhatsappInstanceAccess', () => {
  const real = jest.requireActual('../services/chat/access/usuarioWhatsappInstanceAccessRules')
  return { carregarMapaAcessoNumeros: jest.fn(), atendentePodeVerNumero: real.atendentePodeVerNumero }
})
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
const acessoNumeros = require('../services/chat/access/usuarioWhatsappInstanceAccess')
const { removerAtendenteConversa, adicionarAtendenteConversa, transferirChat, listarAtendentesConversa } = require('../controllers/chat/attendanceController')

// Conversa 10: responsável = 9; co-atendente 5 foi incluído por 7.
const conv = { id: 10, atendente_id: 9, status_atendimento: 'em_atendimento', whatsapp_instance_id: 3 }
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
  acessoNumeros.carregarMapaAcessoNumeros.mockResolvedValue(new Map())
  supabase.from.mockImplementation((table) => {
    const q = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order']) q[m] = jest.fn(() => q)
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

test('não adiciona co-atendente travado em outro número (nunca veria a conversa na Minha fila)', async () => {
  acessoNumeros.carregarMapaAcessoNumeros.mockResolvedValue(new Map([[5, new Set([8])]]))
  const res = response(); await adicionarAtendenteConversa(req({ userId: 9, alvo: 5 }), res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CO_ATENDENTE_SEM_ACESSO_AO_NUMERO' }))
  expect(gateway.emitirParaUsuario).not.toHaveBeenCalled()
})

test('adiciona co-atendente liberado no número da conversa', async () => {
  acessoNumeros.carregarMapaAcessoNumeros.mockResolvedValue(new Map([[5, new Set([3, 8])]]))
  const res = response(); await adicionarAtendenteConversa(req({ userId: 9, alvo: 5 }), res)
  expect(res.status).toHaveBeenCalledWith(201)
  expect(gateway.emitirParaUsuario).toHaveBeenCalledWith(io, 5, 'conversa_atendente_adicionado', expect.objectContaining({ conversa_id: 10 }))
})

describe('transferir: co-atendimento acompanha o responsável', () => {
  const reqTransferir = (paraUsuarioId) => ({
    user: { id: 9, company_id: 1, perfil: 'atendente' },
    params: { id: 10 },
    body: { para_usuario_id: paraUsuarioId },
    app: { get: () => undefined },
  })

  test('quem recebe a conversa deixa de ser co-atendente (não aparece duas vezes)', async () => {
    const res = response(); await transferirChat(reqTransferir(5), res)
    expect(res.status).not.toHaveBeenCalledWith(409)
    expect(visibility.encerrarCoAtendimentoDaConversa).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 1, conversa_id: 10, usuario_id: 5 })
    )
  })

  test('transferir conversa que estava na fila começa atendimento novo (desativa todos)', async () => {
    assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...conv, atendente_id: null, status_atendimento: 'aberta' } })
    const res = response(); await transferirChat(reqTransferir(5), res)
    expect(visibility.encerrarCoAtendimentoDaConversa).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 1, conversa_id: 10, usuario_id: null })
    )
  })
})

test('modal nunca lista o responsável também como co-atendente', async () => {
  supabase.from.mockImplementation((table) => {
    const q = {}
    for (const m of ['select', 'eq', 'in', 'order']) q[m] = jest.fn(() => q)
    const data = table === 'conversa_atendentes'
      ? [{ id: 1, usuario_id: 9, adicionado_por: 7, ativo: true }, { id: 2, usuario_id: 5, adicionado_por: 9, ativo: true }]
      : [{ id: 9, nome: 'Resp' }, { id: 5, nome: 'Co' }, { id: 7, nome: 'X' }]
    q.then = (ok, fail) => Promise.resolve({ data, error: null }).then(ok, fail)
    return q
  })
  const res = response(); await listarAtendentesConversa(req({ userId: 9 }), res)
  const lista = res.json.mock.calls[0][0]
  expect(lista.map((p) => [p.tipo, p.usuario_id])).toEqual([['principal', 9], ['participante', 5]])
})
