/**
 * O emit de `conversa_atualizada` é o outro caminho pelo qual um nome chega ao card da lista —
 * e o frontend aplica `nome_contato_cache` não-vazio sem reavaliar
 * (`chatsStore.mergeConversaPartial`).
 *
 * O cache do BANCO já recusa pushname ruim (`chooseBestName`/`isBadName`); o emit NÃO recusava,
 * então o pushname cru do payload ("❤", medido no canal em 21/10) sobrescrevia no card o nome
 * salvo na agenda e o nome certo só voltava no F5. Ver doc 25, seção 2026-10-21.
 *
 * Mocks no mesmo desenho de `tests/receberZapiInbound.test.js`.
 */

jest.mock('../services/whatsappInstanceService', () => ({
  ...jest.requireActual('../services/whatsappInstanceService'),
  getWhatsappInstanceByProviderInstanceId: jest.fn(),
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
jest.mock('../services/ultramsgGroupsSyncService', () => ({
  syncConversationGroupOnJoin: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => ({
  ...jest.requireActual('../controllers/webhookInbound/whatsappIdLookup'),
  selectSingleMensagemByWhatsappId: jest.fn(() => Promise.resolve({ data: null, error: null, ambiguous: false })),
}))
// Os dois caminhos que levam o nome para FORA do ZapERP (CRM Avançado).
jest.mock('../controllers/webhookInbound/crmLeadInbound', () => ({
  scheduleInboundLeadCapture: jest.fn(),
}))
jest.mock('../controllers/webhookInbound/crmInboxInbound', () => ({
  ...jest.requireActual('../controllers/webhookInbound/crmInboxInbound'),
  scheduleInboundCrmForward: jest.fn(),
}))

const { getOrCreateCliente, findOrCreateConversation } = require('../helpers/conversationSync')
const { emitirParaUsuariosQuePodemVerConversa } = require('../controllers/chatController')
const { scheduleInboundLeadCapture } = require('../controllers/webhookInbound/crmLeadInbound')
const { scheduleInboundCrmForward } = require('../controllers/webhookInbound/crmInboxInbound')
const { receberZapi } = require('../controllers/webhookZapiController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function buildReq(body) {
  const chain = { emit: jest.fn(), to: jest.fn(() => chain) }
  return {
    body,
    zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    app: { get: (k) => (k === 'io' ? { to: jest.fn(() => chain), EVENTS: {} } : undefined) },
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
  }
}

/** Payload de um emit por nome de evento (assinatura: io, company_id, conversa_id, evento, payload). */
function payloadDoEvento(evento) {
  const call = emitirParaUsuariosQuePodemVerConversa.mock.calls.find((c) => c[3] === evento)
  return call ? call[4] : null
}
function payloadConversaAtualizada() {
  return payloadDoEvento('conversa_atualizada')
}

describe('Webhook inbound — emit de conversa_atualizada e o nome do contato', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getOrCreateCliente.mockResolvedValue({ cliente_id: 7 })
    // Conversa já com departamento → o triage é pulado e cai direto na persistência + emit.
    findOrCreateConversation.mockResolvedValue({
      conversa: { id: 10, departamento_id: 1, atendente_id: null, telefone: '553497829258' },
      created: false,
    })
  })

  test('pushname de emoji NÃO vai no emit (não sobrescreve o nome do card)', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-EMOJI-1',
      text: { message: 'oi' }, fromMe: false, pushName: '❤',
    }), buildRes())
    const p = payloadConversaAtualizada()
    expect(p).not.toBeNull()
    expect(p.nome_contato_cache ?? null).toBeNull()
    expect(p.contato_nome ?? null).toBeNull()
  })

  test('pushname de verdade continua indo no emit', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-NOME-1',
      text: { message: 'oi' }, fromMe: false, pushName: 'Rayssa',
    }), buildRes())
    const p = payloadConversaAtualizada()
    expect(p?.nome_contato_cache).toBe('Rayssa')
    expect(p?.contato_nome).toBe('Rayssa')
  })

  test('telefone como pushname NÃO vai no emit', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-TEL-1',
      text: { message: 'oi' }, fromMe: false, pushName: '553497829258',
    }), buildRes())
    const p = payloadConversaAtualizada()
    expect(p?.nome_contato_cache ?? null).toBeNull()
  })

  test('nova_mensagem não leva o pushname ruim como senderName/chatName', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-MSG-EMOJI',
      text: { message: 'oi' }, fromMe: false, pushName: '❤',
    }), buildRes())
    const p = payloadDoEvento('nova_mensagem')
    expect(p).not.toBeNull()
    expect(p.senderName ?? null).toBeNull()
    expect(p.chatName ?? null).toBeNull()
  })

  test('nova_mensagem continua levando pushname de verdade', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-MSG-NOME',
      text: { message: 'oi' }, fromMe: false, pushName: 'Rayssa',
    }), buildRes())
    const p = payloadDoEvento('nova_mensagem')
    expect(p?.senderName).toBe('Rayssa')
    expect(p?.chatName).toBe('Rayssa')
  })

  test('o nome que vai para o inbox do CRM também é filtrado', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-CRM-EMOJI',
      text: { message: 'oi' }, fromMe: false, pushName: '❤',
    }), buildRes())
    expect(scheduleInboundCrmForward).toHaveBeenCalled()
    expect(scheduleInboundCrmForward.mock.calls[0][0].nome ?? null).toBeNull()
  })
})

describe('Webhook inbound — conversa NOVA (nova_conversa e lead do CRM)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getOrCreateCliente.mockResolvedValue({ cliente_id: 7 })
    // `created: true` → isNewConversation: emite nova_conversa e captura lead no CRM.
    findOrCreateConversation.mockResolvedValue({
      conversa: { id: 11, departamento_id: 1, atendente_id: null, telefone: '553497829258' },
      created: true,
    })
  })

  test('nova_conversa com pushname ruim cai no telefone, não em "❤"', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-NOVA-EMOJI',
      text: { message: 'oi' }, fromMe: false, pushName: '❤',
    }), buildRes())
    const p = payloadDoEvento('nova_conversa')
    expect(p).not.toBeNull()
    expect(p.contato_nome).not.toBe('❤')
    expect(String(p.contato_nome || '').replace(/\D/g, '')).toContain('553497829258')
  })

  test('nova_conversa com pushname de verdade usa o pushname', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-NOVA-NOME',
      text: { message: 'oi' }, fromMe: false, pushName: 'Rayssa',
    }), buildRes())
    expect(payloadDoEvento('nova_conversa')?.contato_nome).toBe('Rayssa')
  })

  test('lead criado no CRM não nasce chamado "❤"', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-LEAD-EMOJI',
      text: { message: 'oi' }, fromMe: false, pushName: '❤',
    }), buildRes())
    expect(scheduleInboundLeadCapture).toHaveBeenCalled()
    const arg = scheduleInboundLeadCapture.mock.calls[0][0]
    expect(arg.nomeParaCache ?? null).toBeNull()
    expect(arg.senderName ?? null).toBeNull()
    expect(arg.chatName ?? null).toBeNull()
  })

  test('lead criado no CRM mantém nome de verdade', async () => {
    await receberZapi(buildReq({
      instanceId: 'inst-1', phone: '553497829258', messageId: 'WAMID-LEAD-NOME',
      text: { message: 'oi' }, fromMe: false, pushName: 'Rayssa',
    }), buildRes())
    const arg = scheduleInboundLeadCapture.mock.calls[0][0]
    expect(arg.nomeParaCache || arg.senderName).toBe('Rayssa')
  })
})

describe('primeiroNomeUtilizavel — a regra, num lugar só', () => {
  const { primeiroNomeUtilizavel } = require('../helpers/contactEnrichment')

  test('devolve o primeiro nome que presta, na ordem dada', () => {
    expect(primeiroNomeUtilizavel('❤', 'Rayssa', 'Outro')).toBe('Rayssa')
  })

  test('recusa emoji, telefone, placeholder e vazio', () => {
    expect(primeiroNomeUtilizavel('❤')).toBeNull()
    expect(primeiroNomeUtilizavel('553497829258')).toBeNull()
    expect(primeiroNomeUtilizavel('Contato')).toBeNull()
    expect(primeiroNomeUtilizavel('   ')).toBeNull()
    expect(primeiroNomeUtilizavel(null, undefined)).toBeNull()
  })

  test('normaliza espaço sobrando', () => {
    expect(primeiroNomeUtilizavel('  Claudia   DB  ')).toBe('Claudia DB')
  })
})
