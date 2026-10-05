/**
 * ACK de FALHA da Whapi aplicado pelo statusZapi (2ª auditoria do envio):
 *  - `failed` sobre mensagem pending/sending → marca erro + emite status_mensagem (ticks).
 *  - `failed` sobre mensagem já sent/delivered/read → NÃO regride (falha tardia é ambígua).
 *  - ACK atrasado (delivered depois de read) continua sem regressão.
 *  - ACK de sucesso tardio sobre linha erro RECUPERA (sent vence erro).
 */

describe('statusZapi — ACK failed Whapi e ordenação de ACKs', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ currentStatus }) {
    jest.resetModules()

    const updates = []
    jest.doMock('../config/supabase', () => ({ from: () => { throw new Error('supabase direto não deveria ser usado neste cenário') } }))
    jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
    jest.doMock('../services/whatsappInstanceService', () => ({ getWhatsappInstanceByProviderInstanceId: jest.fn() }))
    jest.doMock('../services/disparoWebhookHook', () => ({ aplicarStatusDisparoFromWebhook: jest.fn(async () => {}) }))
    jest.doMock('../services/mediaR2MirrorService', () => ({ scheduleR2MirrorIfNeeded: jest.fn() }))
    jest.doMock('../controllers/webhookInbound/fromMeReconcile', () => ({
      filterRowsForFromMeReconcile: jest.fn(() => []),
      findPendingOutboundByAckPhone: jest.fn(async () => null),
    }))
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      selectSingleMensagemByWhatsappId: jest.fn(async (_s, { select }) => {
        if (select === 'conversa_id') return { data: { conversa_id: 2 } }
        return { data: { status: currentStatus } }
      }),
      updateSingleMensagemByWhatsappId: jest.fn(async (_s, { updates: u }) => {
        updates.push(u)
        return {
          data: {
            id: 9,
            conversa_id: 2,
            company_id: 1,
            autor_usuario_id: 4,
            whatsapp_instance_id: 5,
            whatsapp_id: 'WAMID-WHAPI-1',
          },
        }
      }),
      selectSingleMensagemByWhatsappIdRelaxed: jest.fn(async () => ({ data: null })),
      patchMensagemStatusById: jest.fn(async () => ({ data: null })),
      applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
      logAmbiguousWhatsappId: jest.fn(),
    }))

    const { statusZapi } = require('../controllers/webhookInbound/statusZapi')

    const emitted = []
    const chain = { to: () => chain, emit: (ev, payload) => emitted.push({ ev, payload }) }
    const io = { to: () => chain }
    const req = (body) => ({
      path: '/webhooks/whapi',
      body,
      zapiContext: { company_id: 1, whatsapp_instance_id: 5 },
      app: { get: () => io },
    })
    const res = () => {
      const out = { statusCode: 200, body: null }
      return {
        out,
        status(c) { out.statusCode = c; return this },
        json(o) { out.body = o; return this },
      }
    }

    return { statusZapi, updates, emitted, req, res }
  }

  // Payload no formato que normalizeWhapiStatusToInternal entrega ao statusZapi.
  const ackWhapi = (status) => ({
    type: 'MessageStatusCallback',
    ids: ['WAMID-WHAPI-1'],
    messageId: 'WAMID-WHAPI-1',
    ack: status === 'erro' ? 'failed' : status,
    status,
    referenceId: null,
  })

  test('failed sobre pending aplica erro e emite status_mensagem=erro', async () => {
    const { statusZapi, updates, emitted, req, res } = montar({ currentStatus: 'pending' })
    const r = res()
    await statusZapi(req(ackWhapi('erro')), r)

    expect(r.out.statusCode).toBe(200)
    expect(updates[0]).toEqual({ status: 'erro', status_mensagem: 'erro' })
    const evt = emitted.find((e) => e.ev === 'status_mensagem')
    expect(evt.payload).toMatchObject({ mensagem_id: 9, conversa_id: 2, status: 'erro' })
  })

  test('failed sobre sending (status_mensagem) também aplica erro', async () => {
    const { statusZapi, updates, req, res } = montar({ currentStatus: 'sending' })
    await statusZapi(req(ackWhapi('erro')), res())
    expect(updates[0]).toEqual({ status: 'erro', status_mensagem: 'erro' })
  })

  test('failed NÃO regride mensagem já sent/delivered', async () => {
    for (const current of ['sent', 'delivered', 'read']) {
      const { statusZapi, updates, req, res } = montar({ currentStatus: current })
      await statusZapi(req(ackWhapi('erro')), res())
      expect(updates[0]).toEqual({ status: current, status_mensagem: current })
    }
  })

  test('ACK atrasado delivered não regride read', async () => {
    const { statusZapi, updates, req, res } = montar({ currentStatus: 'read' })
    await statusZapi(req(ackWhapi('delivered')), res())
    expect(updates[0]).toEqual({ status: 'read', status_mensagem: 'read' })
  })

  test('ACK de sucesso tardio recupera linha marcada erro (sent vence erro)', async () => {
    const { statusZapi, updates, req, res } = montar({ currentStatus: 'erro' })
    await statusZapi(req(ackWhapi('sent')), res())
    expect(updates[0]).toEqual({ status: 'sent', status_mensagem: 'sent' })
  })
})
