/**
 * Doc 29 §3 item 4 — a mensagem de FINALIZAÇÃO saía sem `referenceId`.
 *
 * Consequências reais:
 *  - a varredura de reconciliação consulta o provedor por `crm-{id}`; como esse referenceId
 *    nunca era enviado, a consulta voltava vazia, a varredura concluía "nunca aceito" e
 *    REENVIAVA a mensagem de finalização ao cliente;
 *  - o eco `message_create` não tinha identidade forte para casar com a linha, então corria
 *    com ela e podia criar uma segunda bolha;
 *  - o id de FILA da UltraMSG era descartado (só `whatsapp_id` de id real era gravado), logo
 *    o ACK não tinha coluna para casar e o tique ficava no relógio.
 *
 * A correção segue a ordem do envio normal: INSERT → provider (com crm-{id}) → gravação
 * condicional do resultado.
 */

jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/atendimentosRegistroService', () => ({ registrarAtendimento: jest.fn() }))
jest.mock('../controllers/webhookInbound/recentClosedConversationGuard', () => ({
  rememberClosedConversation: jest.fn(),
}))
jest.mock('../services/chatbotTriageService', () => ({
  resetOpcaoInvalidaLimitForConversa: jest.fn().mockResolvedValue(undefined),
  getChatbotConfig: jest.fn().mockResolvedValue({
    enviarMensagemFinalizacao: true,
    mensagemFinalizacao: 'Atendimento encerrado. Protocolo {protocolo}.',
  }),
  buildMensagemFinalizacao: jest.fn(() => 'Atendimento encerrado. Protocolo 55.'),
}))
jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveConversationWhatsappInstance: jest.fn().mockResolvedValue(7),
  resolveConversationProvider: jest.fn().mockResolvedValue('ultramsg'),
}))

const mockSendText = jest.fn()
jest.mock('../services/providers', () => ({ getProvider: () => ({ sendText: mockSendText }) }))

const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { registrarAtendimento } = require('../services/atendimentosRegistroService')
const { encerrarChat } = require('../controllers/chat/attendanceController')

const CONVERSA = { id: 10, status_atendimento: 'em_atendimento', tipo: 'cliente', telefone: '5534999999999' }

let inserts
let updates
let ordem

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
  inserts = []
  updates = []
  ordem = []
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: CONVERSA })
  registrarAtendimento.mockResolvedValue({ error: null, atendimento: { id: 55 } })
  mockSendText.mockImplementation(async () => {
    ordem.push('send')
    return { ok: true, messageId: '35096' } // id de FILA numérico da UltraMSG
  })

  supabase.from.mockImplementation((table) => {
    const state = { patch: null, insert: null, filtroStatus: null }
    const q = {}
    for (const m of ['select', 'eq', 'neq', 'is', 'order', 'limit']) q[m] = jest.fn(() => q)
    q.in = jest.fn((col, valores) => { if (col === 'status') state.filtroStatus = valores; return q })
    q.update = jest.fn((patch) => {
      state.patch = patch
      if (table === 'mensagens') { ordem.push('update-mensagem'); updates.push({ patch, get filtroStatus() { return state.filtroStatus } }) }
      return q
    })
    q.insert = jest.fn((row) => {
      state.insert = row
      if (table === 'mensagens') { ordem.push('insert-mensagem'); inserts.push(row) }
      return q
    })
    const run = () => {
      if (table === 'conversas' && state.patch?.status_atendimento === 'fechada') {
        return Promise.resolve({ data: { ...CONVERSA, status_atendimento: 'fechada' }, error: null })
      }
      if (table === 'mensagens' && state.insert) {
        return Promise.resolve({ data: { ...state.insert, id: 901 }, error: null })
      }
      if (table === 'mensagens' && state.patch) {
        return Promise.resolve({ data: [{ id: 901 }], error: null })
      }
      if (table === 'usuarios') return Promise.resolve({ data: { nome: 'Ana' }, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    q.single = run
    q.maybeSingle = run
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
})

describe('encerrarChat — mensagem de finalização', () => {
  test('o envio leva referenceId crm-{id} da própria linha', async () => {
    await encerrarChat(req(), response())
    expect(mockSendText).toHaveBeenCalledTimes(1)
    const opts = mockSendText.mock.calls[0][2]
    expect(opts.referenceId).toBe('crm-901')
    expect(opts.sendOrigin).toBe('mensagem_finalizacao_atendimento')
  })

  test('a linha é inserida ANTES do POST (é o que dá id ao referenceId)', async () => {
    await encerrarChat(req(), response())
    expect(ordem.indexOf('insert-mensagem')).toBeGreaterThanOrEqual(0)
    expect(ordem.indexOf('insert-mensagem')).toBeLessThan(ordem.indexOf('send'))
  })

  test('nasce pending/sending e o resultado do envio é gravado depois, condicionado', async () => {
    await encerrarChat(req(), response())
    const inserida = inserts.find((r) => r.texto?.includes('Protocolo'))
    expect(inserida).toMatchObject({ status: 'pending', status_mensagem: 'sending', direcao: 'out', company_id: 1 })
    const gravacao = updates[updates.length - 1]
    expect(gravacao.filtroStatus).toEqual(expect.arrayContaining(['pending', 'sending', 'erro', 'failed']))
  })

  test('id de FILA numérico vai para provider_queue_id (antes era descartado)', async () => {
    await encerrarChat(req(), response())
    const gravacao = updates[updates.length - 1]
    expect(gravacao.patch.provider_queue_id).toBe('35096')
    expect(gravacao.patch.whatsapp_id).toBeUndefined()
  })

  test('encerramento continua respondendo ok mesmo quando o provedor recusa', async () => {
    mockSendText.mockResolvedValue({ ok: false, error: 'destino inválido', httpStatus: 400 })
    const res = response()
    await encerrarChat(req(), res)
    expect(res.status).not.toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })
})
