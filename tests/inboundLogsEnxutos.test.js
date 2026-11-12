/**
 * Logs do caminho quente do inbound (doc 29 §3 item 15).
 *
 * Antes, uma mensagem de texto comum gerava 7 linhas de console no pipeline
 * (`[ULTRAMSG_WEBHOOK]`, `🔍 pipeline`, warn de connectedPhone, `📞 resolveKey`, `📩 recebida`,
 * `Conversa vinculada`, `✅ salva`) — com 8 a 10 dígitos do telefone e, no chatbot, 50 caracteres
 * do texto do cliente. Isto congela o estado novo:
 *
 *   1) caminho de sucesso = no máximo 2 linhas (recebida + salva);
 *   2) nenhuma linha (nem com WHATSAPP_DEBUG) leva o telefone completo nem o texto da mensagem;
 *   3) `WHATSAPP_DEBUG=1` liga o diagnóstico detalhado sem reiniciar o processo.
 *
 * Mocks iguais aos de tests/receberZapiInbound.test.js (o mock global de supabase devolve {id:1}
 * em todo .single()/.maybeSingle()).
 */

process.env.ZAPERP_DISABLE_BACKGROUND_JOBS = '1'
delete process.env.WHATSAPP_DEBUG

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
jest.mock('../controllers/chatController', () => ({
  ...jest.requireActual('../controllers/chatController'),
  incrementarUnreadParaConversa: jest.fn().mockResolvedValue(undefined),
  emitirParaUsuariosQuePodemVerConversa: jest.fn().mockResolvedValue(true),
}))
jest.mock('../controllers/webhookInbound/fromMeReconcile', () => ({
  ...jest.requireActual('../controllers/webhookInbound/fromMeReconcile'),
  tryReconcileFromMeByCrmReferenceId: jest.fn().mockResolvedValue(null),
}))
jest.mock('../services/ultramsgGroupsSyncService', () => ({
  syncConversationGroupOnJoin: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => {
  const actual = jest.requireActual('../controllers/webhookInbound/whatsappIdLookup')
  return {
    ...actual,
    selectSingleMensagemByWhatsappId: jest.fn(() =>
      Promise.resolve({ data: null, error: null, ambiguous: false })),
  }
})
// Push inbound roda em setImmediate e, sem VAPID no ambiente de teste, avisa no console —
// está fora do pipeline do webhook e fora do escopo desta contagem.
jest.mock('../services/webPushDispatchService', () => ({
  ...jest.requireActual('../services/webPushDispatchService'),
  scheduleInboundWebPush: jest.fn(),
}))

const { getOrCreateCliente, findOrCreateConversation } = require('../helpers/conversationSync')
const { tryReconcileFromMeByCrmReferenceId } = require('../controllers/webhookInbound/fromMeReconcile')
const { receberZapi } = require('../controllers/webhookZapiController')

// Telefone e texto FICTÍCIOS, escolhidos para não colidir com ids/números dos mocks.
const TELEFONE = '5534987651234'
const TEXTO = 'segredo do cliente 4321 nao pode ir pro log'

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
function buildReq(body) {
  return {
    body,
    zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    app: { get: (k) => (k === 'io' ? fakeIo() : undefined) },
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
  }
}
function textoInbound(overrides = {}) {
  return { instanceId: 'inst-1', phone: TELEFONE, messageId: 'WAMID-LOG-1', text: { message: TEXTO }, fromMe: false, ...overrides }
}

/** Captura TODO console.* como uma linha de texto (objetos serializados, para pegar campos aninhados). */
function capturarConsole() {
  const linhas = []
  const serializa = (args) => args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch (_) { return String(a) } })()))
    .join(' ')
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
    jest.spyOn(console, m).mockImplementation((...args) => { linhas.push(`${m}: ${serializa(args)}`) }))
  return { linhas, restaurar: () => spies.forEach((s) => s.mockRestore()) }
}

function esperaSemDadoPessoal(linhas) {
  const tudo = linhas.join('\n')
  // Telefone: nem completo, nem o nacional, nem a cauda de 8 dígitos que os logs antigos usavam.
  expect(tudo).not.toContain(TELEFONE)
  expect(tudo).not.toContain(TELEFONE.slice(2))
  expect(tudo).not.toContain(TELEFONE.slice(-8))
  // Texto da mensagem: nem inteiro, nem o prefixo de 30/50/80 caracteres dos logs antigos.
  expect(tudo).not.toContain('segredo do cliente')
  expect(tudo).not.toContain(TEXTO.slice(0, 30))
}

describe('inbound: logs enxutos e sem dado pessoal (doc 29 §3 item 15)', () => {
  let cap
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.WHATSAPP_DEBUG
    getOrCreateCliente.mockResolvedValue({ cliente_id: 7 })
    findOrCreateConversation.mockResolvedValue({
      conversa: { id: 10, departamento_id: 1, atendente_id: null, telefone: TELEFONE },
      created: false,
    })
    tryReconcileFromMeByCrmReferenceId.mockResolvedValue(null)
    cap = capturarConsole()
  })
  afterEach(() => {
    cap.restaurar()
    delete process.env.WHATSAPP_DEBUG
  })

  test('mensagem de texto recebida: no máximo 2 linhas (recebida + salva), telefone mascarado, texto só como tamanho', async () => {
    const res = buildRes()
    await receberZapi(buildReq(textoInbound()), res)
    expect(res.status).toHaveBeenCalledWith(200)

    expect(cap.linhas.length).toBeLessThanOrEqual(2)
    expect(cap.linhas[0]).toContain('mensagem recebida')
    expect(cap.linhas[1]).toContain('Mensagem salva no sistema')
    // Forma mascarada: 4 últimos dígitos e tamanho do texto.
    expect(cap.linhas[0]).toContain('****1234')
    expect(cap.linhas[0]).toContain(`txt:${TEXTO.length}`)
    expect(cap.linhas[1]).toContain('****1234')
    esperaSemDadoPessoal(cap.linhas)
  })

  test('mensagem espelhada do celular (fromMe): também no máximo 2 linhas e sem dado pessoal', async () => {
    const res = buildRes()
    await receberZapi(buildReq(textoInbound({ messageId: 'WAMID-LOG-OUT-1', fromMe: true })), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(cap.linhas.length).toBeLessThanOrEqual(2)
    esperaSemDadoPessoal(cap.linhas)
  })

  test('WHATSAPP_DEBUG=1 liga o diagnóstico detalhado (mais linhas) — e MESMO ASSIM sem telefone completo nem texto', async () => {
    process.env.WHATSAPP_DEBUG = '1'
    const res = buildRes()
    await receberZapi(buildReq(textoInbound({ messageId: 'WAMID-LOG-DBG-1' })), res)
    expect(res.status).toHaveBeenCalledWith(200)

    const tudo = cap.linhas.join('\n')
    expect(cap.linhas.length).toBeGreaterThan(2)
    expect(tudo).toContain('[ULTRAMSG_WEBHOOK]')
    expect(tudo).toContain('pipeline:')
    expect(tudo).toContain('resolveKey')
    esperaSemDadoPessoal(cap.linhas)
  })
})
