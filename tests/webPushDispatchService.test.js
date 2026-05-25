const flushImmediate = () => new Promise((resolve) => setImmediate(resolve))

function makeSupabaseMock({ subscriptions = [] } = {}) {
  const from = jest.fn((table) => {
    if (table === 'push_inbound_delivery_log') {
      return {
        insert: jest.fn().mockResolvedValue({ error: null }),
      }
    }

    if (table === 'push_subscriptions') {
      const chain = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        then: (resolve) => resolve({ data: subscriptions, error: null }),
      }
      return chain
    }

    if (table === 'conversas') {
      const chain = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        maybeSingle: jest.fn().mockResolvedValue({
          data: {
            status_atendimento: 'em_atendimento',
            atendente_id: 7,
            tipo: 'individual',
            telefone: '5511999999999',
            nome_contato_cache: 'Cliente Teste',
            foto_perfil_contato_cache: '',
          },
          error: null,
        }),
      }
      return chain
    }

    return {}
  })

  return { from }
}

function loadDispatchService({ subscriptions = [], fcmOk = true, vapidOk = true } = {}) {
  jest.resetModules()
  delete process.env.WEB_PUSH_FCM_ALONGSIDE_VAPID

  const supabase = makeSupabaseMock({ subscriptions })
  const webPushService = {
    ensureVapidConfigured: jest.fn(() => vapidOk),
    subscriptionFromRow: jest.fn((row) => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } })),
    sendToSubscription: jest.fn().mockResolvedValue({ ok: true }),
  }
  const pushNotificationService = {
    ensureFirebase: jest.fn(() => fcmOk),
    sendNovaMensagemToUser: jest.fn().mockResolvedValue(),
  }

  jest.doMock('../config/supabase', () => supabase)
  jest.doMock('../controllers/chatController', () => ({
    obterUsuarioIdsQuePodemVerConversa: jest.fn().mockResolvedValue([7]),
  }))
  jest.doMock('../services/webPushService', () => webPushService)
  jest.doMock('../services/pushNotificationService', () => pushNotificationService)

  const service = require('../services/webPushDispatchService')
  return { service, webPushService, pushNotificationService }
}

describe('webPushDispatchService', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    delete process.env.WEB_PUSH_FCM_ALONGSIDE_VAPID
  })

  test('envia FCM por padrão mesmo quando o usuário tem subscription VAPID', async () => {
    const { service, webPushService, pushNotificationService } = loadDispatchService({
      subscriptions: [{ endpoint: 'https://push.example/sub', p256dh: 'p256dh', auth: 'auth' }],
    })

    await service.maybeDispatchInboundWebPush({
      company_id: 1,
      conversa_id: 123,
      eventName: 'nova_mensagem',
      payload: {
        id: 'msg-1',
        direcao: 'in',
        fromMe: false,
        texto: 'Oi',
        criado_em: new Date().toISOString(),
      },
    })
    await flushImmediate()

    expect(webPushService.sendToSubscription).toHaveBeenCalledTimes(1)
    expect(pushNotificationService.sendNovaMensagemToUser).toHaveBeenCalledTimes(1)
    expect(pushNotificationService.sendNovaMensagemToUser).toHaveBeenCalledWith({
      empresa_id: 1,
      usuario_id: 7,
      conversa_id: 123,
      mensagem_id: 'msg-1',
      nomeCliente: 'Cliente Teste',
    })
  })
})
