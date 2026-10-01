/**
 * Endurecimento anti-perda do inbound (doc 30 — forense "caso Enzo").
 * Cobre os caminhos onde mensagem GENUÍNA do cliente se perdia com HTTP 200:
 *  - #4 eco por padrão de texto sem corroboração → agora persiste (confidence 'weak')
 *  - #5 UltraMSG @lid → chave lid: preservada (não vira dígitos não-BR descartados)
 *  - #7 whatsapp_id nunca cai no fallback instanceId (dedup falsa engolia a 2ª mensagem)
 *  - #3 erro de banco no resolve da instância → 500 (reentrega), não ignored_not_mapped 200
 *  - #1/#2 falha de persistência/conversa → 500 (reentrega), não 200
 *  - #6 Whapi: item "histórico" recente e ainda não persistido é RECUPERADO (reentrega pós-500/queda)
 */

process.env.ZAPERP_DISABLE_BACKGROUND_JOBS = '1'

describe('eco em conversa fechada — confiança do veredicto (#4)', () => {
  const {
    rememberClosedConversation,
    resetRecentClosedConversationsForTests,
  } = require('../controllers/webhookInbound/recentClosedConversationGuard')
  const { detectOwnOutboundEcho } = require('../controllers/webhookInbound/closedConversationEcho')

  function mockSupabase({ outboundTexts = [], outboundByWaId = null } = {}) {
    return {
      from() {
        const q = {
          select() { return q },
          eq(col, val) {
            if (col === 'whatsapp_id') q._wa = val
            return q
          },
          gte() { return q },
          order() { return q },
          limit() { return q },
          maybeSingle: async () => ({
            data: q._wa && outboundByWaId ? outboundByWaId : null,
            error: null,
          }),
          then(resolve, reject) {
            return Promise.resolve({
              data: outboundTexts.map((texto) => ({ texto })),
              error: null,
            }).then(resolve, reject)
          },
        }
        return q
      },
    }
  }

  beforeEach(() => resetRecentClosedConversationsForTests())

  const finalizacao = 'Atendimento finalizado com sucesso. Segue seu protocolo: *63902*.'

  test('template SEM memória e SEM outbound recente → weak (mensagem deve ser persistida)', async () => {
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase(),
      company_id: 1,
      conversa_id: 10,
      texto: finalizacao,
    })
    expect(r.isEcho).toBe(true)
    expect(r.confidence).toBe('weak')
  })

  test('template corroborado pela memória de fechamento recente → strong', async () => {
    rememberClosedConversation({ companyId: 1, conversaId: 10, texto: finalizacao })
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase(),
      company_id: 1,
      conversa_id: 10,
      texto: finalizacao,
    })
    expect(r.isEcho).toBe(true)
    expect(r.confidence).toBe('strong')
  })

  test('template corroborado por outbound recente com o mesmo template → strong', async () => {
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({ outboundTexts: ['Atendimento finalizado. Segue seu protocolo: *1*.'] }),
      company_id: 1,
      conversa_id: 10,
      texto: finalizacao,
    })
    expect(r.isEcho).toBe(true)
    expect(r.confidence).toBe('strong')
  })

  test('igualdade com outbound dos últimos 3 min continua strong (eco_recent_outbound)', async () => {
    const agente = 'Resolvido por ligação. Cliente estava acessando dentro do servidor, e a tef funciona somente fora.'
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({ outboundTexts: [agente] }),
      company_id: 1,
      conversa_id: 10,
      texto: agente,
    })
    expect(r.isEcho).toBe(true)
    expect(r.confidence).toBe('strong')
  })

  test('whatsapp_id gravado como out continua strong', async () => {
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({ outboundByWaId: { id: 55, direcao: 'out' } }),
      company_id: 1,
      conversa_id: 10,
      texto: 'qualquer',
      messageId: 'wamid.OUT',
    })
    expect(r.isEcho).toBe(true)
    expect(r.confidence).toBe('strong')
  })
})

describe('extractMessage — whatsapp_id sem fallback de instanceId (#7)', () => {
  const { extractMessage } = require('../controllers/webhookInbound/payload')

  test('payload sem id de mensagem → messageId null (nunca o instanceId)', () => {
    const m = extractMessage({
      instanceId: 'inst-51534',
      phone: '5534999999999',
      fromMe: false,
      message: 'primeira sem id',
    })
    expect(m.messageId).toBeNull()
  })

  test('payload com messageId real continua usando o id da mensagem', () => {
    const m = extractMessage({
      instanceId: 'inst-51534',
      phone: '5534999999999',
      messageId: 'WAMID-REAL',
      fromMe: false,
      message: 'oi',
    })
    expect(m.messageId).toBe('WAMID-REAL')
  })
})

describe('normalizeUltramsgToZapi — @lid preservado (#5)', () => {
  const { _test } = require('../controllers/webhookUltramsgController')

  test('data.from=@lid não vira dígitos não-BR: phone mantém o sufixo @lid', () => {
    const z = _test.normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: 'inst-1',
      data: {
        id: 'false_24601656598766@lid_ABC',
        from: '24601656598766@lid',
        to: '5534984080098@c.us',
        body: 'mensagem do contato lid',
        type: 'chat',
        fromMe: false,
        time: Math.floor(Date.now() / 1000),
      },
    })
    expect(z.phone).toBe('24601656598766@lid')
  })

  test('pipeline resolve @lid para chave sintética lid: (não descarta)', () => {
    const { _test: core } = require('../controllers/webhookZapiController')
    const resolved = core.resolveConversationKeyFromZapi({
      phone: '24601656598766@lid',
      fromMe: false,
      connectedPhone: '5534984080098',
      key: { remoteJid: '24601656598766@lid', fromMe: false },
      chatId: '24601656598766@lid',
    })
    expect(resolved.key).toBe('lid:24601656598766')
  })

  test('data.from com número BR real continua normalizando como antes', () => {
    const z = _test.normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: 'inst-1',
      data: {
        id: 'false_5534988887777@c.us_ABC',
        from: '5534988887777@c.us',
        to: '5534984080098@c.us',
        body: 'oi',
        type: 'chat',
        fromMe: false,
      },
    })
    expect(z.phone).toBe('5534988887777')
  })
})

describe('resolve de instância — erro de banco responde 500 (#3)', () => {
  beforeEach(() => jest.resetModules())
  afterEach(() => jest.resetModules())

  test('resolveInboundTenant devolve ignored.status 500 em DB_ERROR', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceByProviderInstanceId: jest.fn().mockResolvedValue({
        instance: null,
        error: 'Erro ao buscar instancia por provider instance_id',
        code: 'DB_ERROR',
      }),
    }))
    jest.doMock('../services/whatsappConfigService', () => ({
      getCompanyIdByInstanceId: jest.fn(),
    }))
    const { resolveInboundTenant } = require('../controllers/webhookInbound/instanceResolve')
    const req = { body: { instanceId: 'inst-db-err', type: 'ReceivedCallback' } }
    const out = await resolveInboundTenant(req)
    expect(out.ignored).toBeDefined()
    expect(out.ignored.status).toBe(500)
    expect(req.webhookLogData.status).toBe('resolve_db_error')
  })

  test('instância realmente inexistente continua 200 instance_not_mapped', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceByProviderInstanceId: jest.fn().mockResolvedValue({
        instance: null,
        error: 'Instancia WhatsApp nao encontrada',
      }),
    }))
    jest.doMock('../services/whatsappConfigService', () => ({
      getCompanyIdByInstanceId: jest.fn().mockResolvedValue(null),
    }))
    const { resolveInboundTenant } = require('../controllers/webhookInbound/instanceResolve')
    const out = await resolveInboundTenant({ body: { instanceId: 'inst-x' } })
    expect(out.ignored.status).toBe(200)
    expect(out.ignored.body.ignored).toBe('instance_not_mapped')
  })
})

describe('receberZapi — falha de persistência/conversa responde 500 (#1/#2)', () => {
  beforeEach(() => jest.resetModules())
  afterEach(() => jest.resetModules())

  function buildRes() {
    const res = {}
    res.status = jest.fn().mockReturnValue(res)
    res.json = jest.fn().mockReturnValue(res)
    return res
  }

  test('findOrCreateConversation lança (erro transitório de banco) → 500 persist_failed', async () => {
    jest.doMock('../helpers/conversationSync', () => ({
      ...jest.requireActual('../helpers/conversationSync'),
      getOrCreateCliente: jest.fn().mockResolvedValue({ cliente_id: 7 }),
      findOrCreateConversation: jest.fn().mockRejectedValue(new Error('timeout supabase')),
    }))
    const { receberZapi } = require('../controllers/webhookZapiController')
    const res = buildRes()
    const req = {
      body: { instanceId: 'inst-1', phone: '5534999999999', messageId: 'WAMID-F1', text: { message: 'oi' }, fromMe: false },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
      app: { get: () => undefined },
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
    }
    await receberZapi(req, res)
    expect(res.status).toHaveBeenCalledWith(500)
    const payload = res.json.mock.calls[0][0]
    expect(payload.error).toBe('persist_failed')
    expect(req.webhookLogData.status).toBe('persist_failed')
  })
})

describe('Whapi — recuperação de inbound marcado como histórico (#6)', () => {
  let receberZapi, statusZapi, controller, lookupMock
  const OLD_ENV = process.env.WHAPI_INBOUND_MAX_AGE_MINUTES
  const OLD_REC = process.env.WHAPI_HISTORICAL_RECOVERY_MAX_AGE_MINUTES

  beforeEach(() => {
    jest.resetModules()
    receberZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    statusZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    lookupMock = jest.fn().mockResolvedValue({ data: null, error: null, ambiguous: false })
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi, statusZapi }))
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      ...jest.requireActual('../controllers/webhookInbound/whatsappIdLookup'),
      selectSingleMensagemByWhatsappId: lookupMock,
    }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => {
    jest.resetModules()
    if (OLD_ENV === undefined) delete process.env.WHAPI_INBOUND_MAX_AGE_MINUTES
    else process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = OLD_ENV
    if (OLD_REC === undefined) delete process.env.WHAPI_HISTORICAL_RECOVERY_MAX_AGE_MINUTES
    else process.env.WHAPI_HISTORICAL_RECOVERY_MAX_AGE_MINUTES = OLD_REC
  })

  function fakeRes() {
    const r = { statusCode: 200, body: null }
    r.status = (c) => { r.statusCode = c; return r }
    r.json = (o) => { r.body = o; return r }
    return r
  }
  const secAgo = (s) => Math.floor(Date.now() / 1000) - s

  test('inbound de 10 min (teto 2 min) ainda NÃO persistido → recuperado (reentrega pós-500/queda)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '2'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.retry', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'mensagem que falhou antes' }, timestamp: secAgo(10 * 60) },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(lookupMock).toHaveBeenCalled()
    expect(receberZapi).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })

  test('inbound de 10 min JÁ persistido → descartado (reentrega legítima, sem reprocesso)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '2'
    lookupMock.mockResolvedValue({ data: { id: 123 }, error: null, ambiguous: false })
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.dup', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'já salva' }, timestamp: secAgo(10 * 60) },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(req.webhookLogData.counts.skipped_historical).toBe(1)
  })

  test('backlog antigo (além da janela de recuperação) continua descartado', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '2'
    process.env.WHAPI_HISTORICAL_RECOVERY_MAX_AGE_MINUTES = '60'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.backlog', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'atendimento de semanas atrás' }, timestamp: 1700000000 },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(req.webhookLogData.counts.skipped_historical).toBe(1)
  })

  test('from_me histórico nunca é recuperado (só mensagem do cliente)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '2'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.mine', from_me: true, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'nossa msg antiga' }, timestamp: secAgo(10 * 60) },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(req.webhookLogData.counts.skipped_historical).toBe(1)
  })

  test('janela de recuperação 0 desliga a recuperação (comportamento antigo)', async () => {
    process.env.WHAPI_INBOUND_MAX_AGE_MINUTES = '2'
    process.env.WHAPI_HISTORICAL_RECOVERY_MAX_AGE_MINUTES = '0'
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [
        { id: 'w.off', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'recovery off' }, timestamp: secAgo(10 * 60) },
      ] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(req.webhookLogData.counts.skipped_historical).toBe(1)
  })
})
