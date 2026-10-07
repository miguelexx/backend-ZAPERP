jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  usuarioParticipaAtivamenteDaConversa: jest.fn(),
  getConversaParticipanteIdsAtivos: jest.fn(),
  invalidateConversaVisibilityCache: jest.fn(),
}))
jest.mock('../services/atendimentosRegistroService', () => ({ registrarAtendimento: jest.fn().mockResolvedValue({}) }))
const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const visibility = require('../services/chat/access/conversationVisibilityService')
const { adicionarAtendenteConversa } = require('../controllers/chat/attendanceController')

let insertError, writes
const conv = { id: 10, atendente_id: 9, status_atendimento: 'em_atendimento' }
const req = (target = 2, perfil = 'atendente') => ({ user: { id: 2, company_id: 1, perfil }, params: { id: 10 }, body: { usuario_id: target }, app: { get: () => null } })
const response = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r }
beforeEach(() => {
  jest.clearAllMocks(); insertError = null; writes = []
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv })
  visibility.usuarioParticipaAtivamenteDaConversa.mockResolvedValue(false)
  visibility.getConversaParticipanteIdsAtivos.mockResolvedValue([])
  supabase.from.mockImplementation(table => {
    const q = {}
    for (const method of ['select', 'eq']) q[method] = jest.fn(() => q)
    q.insert = jest.fn(row => { writes.push({ table, row }); return q })
    const run = () => Promise.resolve(table === 'usuarios'
      ? { data: { id: 2, nome: 'Atendente', perfil: 'atendente', ativo: true } }
      : { data: { id: 21, ativo: true }, error: insertError })
    q.single = run; q.maybeSingle = run; q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})
test('transferidor volta como participante e preserva o responsável', async () => {
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(201)
  expect(writes).toEqual([{ table: 'conversa_atendentes', row: { company_id: 1, conversa_id: 10, usuario_id: 2, adicionado_por: 2, ativo: true } }])
})
test('transferidor não pode incluir terceiros só por ter visibilidade', async () => {
  const res = response(); await adicionarAtendenteConversa(req(3), res)
  expect(res.status).toHaveBeenCalledWith(403); expect(writes).toEqual([])
})
test.each(['fechada', 'finalizado', 'finalizada', 'encerrada'])('finalizada %s nunca é tratada como sucesso', async status => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...conv, status_atendimento: status } })
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(409); expect(writes).toEqual([])
})
test('sem principal exige assumir', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...conv, atendente_id: null } })
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(409); expect(writes).toEqual([])
})
test('participação já confirmada é idempotente', async () => {
  visibility.usuarioParticipaAtivamenteDaConversa.mockResolvedValue(true)
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.json).toHaveBeenCalledWith({ ok: true, already_participant: true }); expect(writes).toEqual([])
})
test('limite atingido recusa sem inserir', async () => {
  visibility.getConversaParticipanteIdsAtivos.mockResolvedValue([4, 5, 6])
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(409); expect(writes).toEqual([])
})
test('duplicidade concorrente só confirma se participação existe', async () => {
  insertError = { code: '23505' }
  visibility.usuarioParticipaAtivamenteDaConversa.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.json).toHaveBeenCalledWith({ ok: true, already_participant: true })
})
test('duplicidade sem participação ativa é conflito real', async () => {
  insertError = { code: '23505' }
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(409)
})
test('guarda atômica de limite/encerramento vira conflito legível', async () => {
  insertError = { code: 'P0001', message: 'Reabra a conversa antes de adicionar atendente.' }
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(res.json).toHaveBeenCalledWith({ error: insertError.message })
})
test('permissão negada ou outra empresa não escreve', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: false, status: 403, error: 'Sem acesso' })
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(403); expect(writes).toEqual([])
})

test.each(['admin', 'supervisor'])('%s pode adicionar outro atendente', async perfil => {
  const res = response(); await adicionarAtendenteConversa(req(3, perfil), res)
  expect(res.status).toHaveBeenCalledWith(201)
  expect(writes[0].row.usuario_id).toBe(3)
})
test('principal pode incluir outro atendente', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...conv, atendente_id: 2 } })
  const res = response(); await adicionarAtendenteConversa(req(3), res)
  expect(res.status).toHaveBeenCalledWith(201)
})
test('grupo não permite co-atendimento', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { ...conv, tipo: 'grupo' } })
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(400); expect(writes).toEqual([])
})
test('falha de persistência nunca confirma participação', async () => {
  insertError = { code: 'XX000', message: 'Falha de banco' }
  const res = response(); await adicionarAtendenteConversa(req(), res)
  expect(res.status).toHaveBeenCalledWith(500)
  expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
})
