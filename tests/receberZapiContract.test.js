/**
 * Testes de caracterização do handler HTTP receberZapi (webhook inbound).
 *
 * Congelam o CONTRATO HTTP de retorno cedo — o invariante §4.7 do doc 24: instância não mapeada /
 * duplicada respondem 200 (nunca erro/500, senão o UltraMSG reentrega em loop). Não existia teste
 * e2e deste handler (só funções puras + hooks); esta é a rede de segurança para a Fase 5
 * (decomposição do orquestrador ~2.900 linhas).
 *
 * Escopo deliberado: os caminhos determinísticos de saída antecipada, que não exigem orquestrar
 * conversationSync/chatbot/mídia. Usa o mock global de supabase (tests/setup.js) e mocka apenas a
 * resolução de instância (whatsappInstanceService / whatsappConfigService).
 */

process.env.ZAPERP_DISABLE_BACKGROUND_JOBS = '1'

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
}))

const { getWhatsappInstanceByProviderInstanceId } = require('../services/whatsappInstanceService')
const { getCompanyIdByInstanceId } = require('../services/whatsappConfigService')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { receberZapi } = require('../controllers/webhookZapiController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
function buildReq(overrides = {}) {
  return {
    body: {},
    zapiContext: undefined,
    app: { get: () => undefined },
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
    ...overrides,
  }
}

describe('receberZapi — contrato HTTP de saída antecipada (caracterização)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('sem instanceId (body vazio, sem zapiContext) → 200 instance_not_mapped', async () => {
    const res = buildRes()
    await receberZapi(buildReq({ body: {} }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true, ignored: 'instance_not_mapped' })
  })

  test('instância duplicada no provider → 200 duplicate_provider_instance, sem seguir o pipeline', async () => {
    getWhatsappInstanceByProviderInstanceId.mockResolvedValueOnce({ code: 'DUPLICATE_PROVIDER_INSTANCE' })
    const res = buildRes()
    await receberZapi(buildReq({ body: { instanceId: 'inst-dup' } }), res)
    expect(getWhatsappInstanceByProviderInstanceId).toHaveBeenCalledWith('ultramsg', 'inst-dup')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true, ignored: 'duplicate_provider_instance' })
  })

  test('instanceId que não resolve empresa → 200 instance_not_mapped', async () => {
    getWhatsappInstanceByProviderInstanceId.mockResolvedValueOnce(null)
    getCompanyIdByInstanceId.mockResolvedValueOnce(null)
    const res = buildRes()
    await receberZapi(buildReq({ body: { instanceId: 'inst-x' } }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true, ignored: 'instance_not_mapped' })
  })

  test('payload só de foto de grupo (com instância mapeada via zapiContext) → 200 com updated', async () => {
    const res = buildRes()
    await receberZapi(buildReq({
      body: { instanceId: 'inst-1', groupId: '55349999-group', groupPhoto: 'https://cdn.exemplo/p.jpg' },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    }), res)
    // Não resolve instância (company_id já veio do contexto) e cai no callback de foto de grupo.
    expect(getWhatsappInstanceByProviderInstanceId).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.json.mock.calls[0][0]
    expect(payload).toMatchObject({ ok: true })
    expect(payload).toHaveProperty('updated')
  })

  test('erro interno ao processar inbound (getOrCreateCliente falha) → 500 para o provider reentregar', async () => {
    // §4.7: inbound com erro interno responde 500 (o UltraMSG reentrega). Forçamos getOrCreateCliente a
    // falhar em um inbound normal (texto, !fromMe, instância via zapiContext); o erro sobe ao catch externo.
    getOrCreateCliente.mockRejectedValue(new Error('boom cliente'))
    const res = buildRes()
    await receberZapi(buildReq({
      body: { instanceId: 'inst-1', phone: '5534999999999', messageId: 'WAMID123', text: { message: 'oi' }, fromMe: false },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
    }), res)
    expect(getOrCreateCliente).toHaveBeenCalled() // caminho de processamento exercido
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao processar webhook' })
  })
})
