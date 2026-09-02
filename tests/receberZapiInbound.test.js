/**
 * Testes de caracterização do MIOLO de receberZapi (webhook inbound) — a rede de segurança que
 * faltava antes da Fase 5 fatiar o orquestrador (~2.800 linhas). Complementam
 * tests/receberZapiContract.test.js (que cobre só as saídas antecipadas + anti-replay).
 *
 * Congelam dois comportamentos observáveis, via SPIES (o mock global de supabase é um chain singleton
 * que devolve {id:1} em todo .single(); não dá para afirmar estado do banco, então observamos os
 * efeitos: unread, emit de socket, e se houve insert/reconcile):
 *
 *   A) Inbound NOVO (texto, !fromMe, não-replay) → persiste (insert) + incrementa unread +
 *      emite `nova_mensagem` e `atualizar_conversa`.
 *   B) Eco `fromMe` reconciliado por `crm-*` → NÃO insere eco novo, NÃO incrementa unread e
 *      NÃO emite `nova_mensagem` (o CRM já emitiu; senão duplicaria a mensagem no front).
 *
 * Se a Fase 5 quebrar qualquer um desses ao mover o insert/idempotência/reconcile, estes testes travam.
 */

process.env.ZAPERP_DISABLE_BACKGROUND_JOBS = '1'

// Resolução de instância: usamos zapiContext, mas mantemos os mocks p/ paridade com o contract test.
jest.mock('../services/whatsappInstanceService', () => ({
  ...jest.requireActual('../services/whatsappInstanceService'),
  getWhatsappInstanceByProviderInstanceId: jest.fn(),
}))
jest.mock('../services/whatsappConfigService', () => ({
  ...jest.requireActual('../services/whatsappConfigService'),
  getCompanyIdByInstanceId: jest.fn(),
}))
jest.mock('../helpers/conversationSync', () => ({
  ...jest.requireActual('../helpers/conversationSync'),
  getOrCreateCliente: jest.fn(),
  findOrCreateConversation: jest.fn(),
}))
jest.mock('../services/chatbotTriageService', () => ({
  ...jest.requireActual('../services/chatbotTriageService'),
  processIncomingMessage: jest.fn(),
}))
// Spies dos efeitos de realtime/unread (o controller importa estas duas de ./chatController).
jest.mock('../controllers/chatController', () => ({
  ...jest.requireActual('../controllers/chatController'),
  incrementarUnreadParaConversa: jest.fn().mockResolvedValue(undefined),
  // Retorna true → o fallback io.to().emit() é pulado; asseveramos sobre esta função.
  emitirParaUsuariosQuePodemVerConversa: jest.fn().mockResolvedValue(true),
}))
// Reconciliação fromMe por crm-* (sibling de webhookInbound). Default: nada reconcilia.
jest.mock('../controllers/webhookInbound/fromMeReconcile', () => ({
  ...jest.requireActual('../controllers/webhookInbound/fromMeReconcile'),
  tryReconcileFromMeByCrmReferenceId: jest.fn().mockResolvedValue(null),
}))
// Idempotência (inboundReentregue): aqui NÃO é replay — o pré-processo não encontra a linha.
jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => {
  const actual = jest.requireActual('../controllers/webhookInbound/whatsappIdLookup')
  return {
    ...actual,
    selectSingleMensagemByWhatsappId: jest.fn(() =>
      Promise.resolve({ data: null, error: null, ambiguous: false })),
  }
})

const { getOrCreateCliente, findOrCreateConversation } = require('../helpers/conversationSync')
const { processIncomingMessage } = require('../services/chatbotTriageService')
const { incrementarUnreadParaConversa, emitirParaUsuariosQuePodemVerConversa } = require('../controllers/chatController')
const { tryReconcileFromMeByCrmReferenceId } = require('../controllers/webhookInbound/fromMeReconcile')
const { receberZapi } = require('../controllers/webhookZapiController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
function fakeIo() {
  const emit = jest.fn()
  const chain = { emit, to: jest.fn(() => chain) }
  return { to: jest.fn(() => chain), EVENTS: {} }
}
function buildReq(overrides = {}) {
  return {
    body: {},
    zapiContext: undefined,
    app: { get: (k) => (k === 'io' ? fakeIo() : undefined) },
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
    ...overrides,
  }
}

describe('receberZapi — miolo inbound (caracterização)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Conversa já atribuída a um departamento → guarda do chatbot (dep==null && atend==null) é falsa,
    // então o triage é pulado e caímos direto no caminho de persistência.
    getOrCreateCliente.mockResolvedValue({ cliente_id: 7 })
    findOrCreateConversation.mockResolvedValue({
      conversa: { id: 10, departamento_id: 1, atendente_id: null, telefone: '5534999999999' },
      created: false,
    })
    tryReconcileFromMeByCrmReferenceId.mockResolvedValue(null)
  })

  test('A) inbound novo (texto, !fromMe) → unread++ e emite nova_mensagem/atualizar_conversa, HTTP 200', async () => {
    const res = buildRes()
    await receberZapi(buildReq({
      body: { instanceId: 'inst-1', phone: '5534999999999', messageId: 'WAMID-NEW-1', text: { message: 'ola' }, fromMe: false },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    // Efeito de recebida: contador não-lido incrementado para a conversa.
    expect(incrementarUnreadParaConversa).toHaveBeenCalledWith(1, 10)
    // Realtime: nova_mensagem (mensagem inserida pelo webhook) e atualizar_conversa (!fromMe).
    const eventos = emitirParaUsuariosQuePodemVerConversa.mock.calls.map((c) => c[3])
    expect(eventos).toContain('nova_mensagem')
    expect(eventos).toContain('atualizar_conversa')
    // Não é reconciliação de eco: o caminho fromMe/crm-* não foi tocado.
    expect(tryReconcileFromMeByCrmReferenceId).not.toHaveBeenCalled()
  })

  test('B) eco fromMe reconciliado por crm-* → sem unread e sem nova_mensagem (não duplica no front)', async () => {
    // O reconcile "encontra" a outbound do CRM → mensagemSalva vem do reconcile, não de um insert novo.
    tryReconcileFromMeByCrmReferenceId.mockResolvedValue({
      id: 55, conversa_id: 10, direcao: 'out', whatsapp_id: 'WAMID-ECHO-1', status: 'sent',
    })
    const res = buildRes()
    await receberZapi(buildReq({
      body: { instanceId: 'inst-1', phone: '5534999999999', messageId: 'WAMID-ECHO-1', text: { message: 'resposta' }, fromMe: true, referenceId: 'crm-123' },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(tryReconcileFromMeByCrmReferenceId).toHaveBeenCalled()
    // fromMe nunca incrementa unread.
    expect(incrementarUnreadParaConversa).not.toHaveBeenCalled()
    // Reconciliação: NÃO emite nova_mensagem (o CRM já emitiu ao enviar).
    const eventos = emitirParaUsuariosQuePodemVerConversa.mock.calls.map((c) => c[3])
    expect(eventos).not.toContain('nova_mensagem')
  })
})
