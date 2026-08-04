const {
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
  extractUltraMsgMessageId,
} = require('../helpers/whatsappMessageIdHelper')
const { _test } = require('../services/pendingOutboundReconciliationService')

describe('whatsappMessageIdHelper', () => {
  test('isRealWhatsAppId aceita hex e ids com @', () => {
    expect(isRealWhatsAppId('BAE543FE1CE17AFA')).toBe(true)
    expect(isRealWhatsAppId('false_5511999999999@c.us_ABC')).toBe(true)
  })

  test('isRealWhatsAppId rejeita id numerico curto de fila', () => {
    expect(isRealWhatsAppId('35096')).toBe(false)
  })

  test('isUltramsgNumericQueueId identifica fila interna', () => {
    expect(isUltramsgNumericQueueId('35096')).toBe(true)
    expect(isUltramsgNumericQueueId('BAE543FE1CE17AFA')).toBe(false)
  })

  test('buildCrmReferenceId', () => {
    expect(buildCrmReferenceId(123)).toBe('crm-123')
    expect(buildCrmReferenceId('abc')).toBeNull()
  })

  test('extractUltraMsgMessageId', () => {
    expect(extractUltraMsgMessageId({ id: 'BAE543FE1CE17AFA', status: 'sent' })).toBe('BAE543FE1CE17AFA')
  })
})

describe('pendingOutboundReconciliationService helpers', () => {
  test('providerRowIndicatesSuccess', () => {
    expect(_test.providerRowIndicatesSuccess({ status: 'sent' })).toBe(true)
    expect(_test.providerRowIndicatesSuccess({ ack: '2' })).toBe(true)
    expect(_test.providerRowIndicatesSuccess({ status: 'queue' })).toBe(false)
  })

  test('providerRowIndicatesFailure', () => {
    expect(_test.providerRowIndicatesFailure({ status: 'unsent' })).toBe(true)
    expect(_test.providerRowIndicatesFailure({ status: 'invalid' })).toBe(true)
    expect(_test.providerRowIndicatesFailure({ status: 'sent' })).toBe(false)
  })

  test('mapProviderAckToStatus', () => {
    expect(_test.mapProviderAckToStatus({ ack: '3' })).toBe('read')
    expect(_test.mapProviderAckToStatus({ status: 'sent' })).toBe('sent')
  })

  test('provedorNuncaAceitou bloqueia qualquer sinal de aceite', () => {
    expect(_test.provedorNuncaAceitou({})).toBe(true)
    expect(_test.provedorNuncaAceitou({ provider_queue_id: '35096' })).toBe(false)
    expect(_test.provedorNuncaAceitou({ whatsapp_id: '35096' })).toBe(false)
    expect(_test.provedorNuncaAceitou({ whatsapp_id: 'BAE543FE1CE17AFA' })).toBe(false)
  })
})

describe('reenvio automatico de pendentes', () => {
  const IDADE_DENTRO_JANELA = () => new Date(Date.now() - 10 * 60_000).toISOString()
  const IDADE_FORA_JANELA = () => new Date(Date.now() - 45 * 60_000).toISOString()

  function montarAmbiente({ getMessagesResult, conversa = { id: 2, telefone: '5511999999999' } }) {
    jest.resetModules()

    const sendText = jest.fn(async () => ({ ok: true, messageId: '35097' }))
    const getMessages = jest.fn(async () => getMessagesResult)
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({
        getMessages,
        sendText,
        getConnectionStatus: async () => ({ configured: true, connected: true }),
      }),
    }))

    const updates = []
    jest.doMock('../config/supabase', () => ({
      from(table) {
        const ctx = { update: null }
        const chain = {
          update(payload) { ctx.update = payload; return chain },
          select() { return chain },
          eq() { return chain },
          is() { return chain },
          in() { return chain },
          gte() { return chain },
          lte() { return chain },
          not() { return chain },
          order() { return chain },
          limit() { return chain },
          async maybeSingle() {
            if (ctx.update) {
              updates.push({ table, ...ctx.update })
              return { data: { id: 1, company_id: 1, conversa_id: 2, autor_usuario_id: 9 }, error: null }
            }
            if (table === 'conversas') return { data: conversa, error: null }
            if (table === 'usuarios') return { data: { nome: 'Miguel', mostrar_nome_ao_cliente: true }, error: null }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }))

    const svc = require('../services/pendingOutboundReconciliationService')
    return { svc, sendText, getMessages, updates }
  }

  function linhaPendente(extra = {}) {
    return {
      id: 1,
      company_id: 1,
      conversa_id: 2,
      autor_usuario_id: 9,
      direcao: 'out',
      tipo: 'texto',
      texto: 'Bom dia, segue o retorno',
      status: 'pending',
      status_mensagem: 'sending',
      whatsapp_id: null,
      provider_queue_id: null,
      criado_em: IDADE_DENTRO_JANELA(),
      ...extra,
    }
  }

  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  test('reenvia quando o provedor confirma que nao tem registro da mensagem', async () => {
    const { svc, sendText, updates } = montarAmbiente({ getMessagesResult: { ok: true, data: [] } })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(res.action).toBe('reenviada')
    expect(updates[0]).toMatchObject({ status: 'pending', provider_queue_id: '35097' })
  })

  test('nao reenvia quando a consulta ao provedor falhou (evita duplicar entregue)', async () => {
    const { svc, sendText } = montarAmbiente({
      getMessagesResult: { ok: false, data: [], error: 'timeout' },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).not.toBe('reenviada')
  })

  test('nao reenvia quando o provedor ja havia aceitado (provider_queue_id)', async () => {
    const { svc, sendText } = montarAmbiente({ getMessagesResult: { ok: true, data: [] } })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ provider_queue_id: '35096' }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).not.toBe('reenviada')
  })

  test('fora da janela de reenvio marca falha definitiva em vez de relogio eterno', async () => {
    const { svc, sendText, updates } = montarAmbiente({ getMessagesResult: { ok: true, data: [] } })

    await svc.reconcilePendingOutboundMessage(
      linhaPendente({ criado_em: IDADE_FORA_JANELA() }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
  })

  test('mensagem sem telefone utilizavel nao e reenviada', async () => {
    const { svc, sendText } = montarAmbiente({
      getMessagesResult: { ok: true, data: [] },
      conversa: { id: 2, telefone: 'lid:12345' },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('skip_reenvio_sem_telefone')
  })
})
