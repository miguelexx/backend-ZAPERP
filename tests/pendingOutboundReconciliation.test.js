const {
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
  extractUltraMsgMessageId,
  areEquivalentWhatsAppIds,
  extractUltramsgSid,
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

  test('areEquivalentWhatsAppIds casa sid com false_jid_sid', () => {
    const sid = '3EB0C767D0A4F1B2A9C8D5E6'
    const full = `false_5511999999999@c.us_${sid}`
    expect(areEquivalentWhatsAppIds(sid, full)).toBe(true)
    expect(areEquivalentWhatsAppIds(full, sid)).toBe(true)
    expect(extractUltramsgSid(full)).toBe(sid)
    expect(areEquivalentWhatsAppIds(sid, '3EB0AAAAAAAAAAAAAAAAAAAA')).toBe(false)
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

  test('providerRowIndicatesPending exige estado explicito do provider', () => {
    expect(_test.providerRowIndicatesPending({ status: 'pending' })).toBe(true)
    expect(_test.providerRowIndicatesPending({ ack: '0' })).toBe(true)
    expect(_test.providerRowIndicatesPending({ status: 'sent' })).toBe(false)
    expect(_test.providerRowIndicatesPending({})).toBe(false)
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

  function montarAmbiente({
    getMessagesResult,
    getMessagesImpl,
    providerName = 'ultramsg',
    conversa = { id: 2, telefone: '5511999999999' },
    chatHistory = null, // { ok, data } de getChatMessages (confirmação Whapi pelo histórico)
    mensagemNoBanco = null, // linha devolvida na releitura pré-reenvio (rowAindaSemAceiteNoBanco)
    donosWhatsappIds = null, // linhas já donas dos ids do histórico (guarda anti-roubo na cura)
  }) {
    jest.resetModules()

    const sendText = jest.fn(async () => ({ ok: true, messageId: '35097' }))
    const getMessages = jest.fn(getMessagesImpl || (async () => getMessagesResult))
    const getChatMessages = jest.fn(async () => chatHistory ?? { ok: false, data: [] })
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({
        getMessages,
        getChatMessages,
        sendText,
        getConnectionStatus: async () => ({ configured: true, connected: true }),
      }),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => providerName),
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
          in() {
            // Consulta de reivindicação da cura (await direto no .in): devolve quem já é
            // dono dos whatsapp_ids encontrados no histórico.
            return {
              then(resolve) {
                resolve({ data: donosWhatsappIds || [], error: null })
              },
            }
          },
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
            if (table === 'mensagens') return { data: mensagemNoBanco, error: null }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }))

    const svc = require('../services/pendingOutboundReconciliationService')
    return { svc, sendText, getMessages, getChatMessages, updates }
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

  test('nao reenvia mensagens do chatbot/automacao (autor_usuario_id null) — evita duplicar menu no cliente', async () => {
    const { svc, sendText, updates } = montarAmbiente({ getMessagesResult: { ok: true, data: [] } })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({
        autor_usuario_id: null,
        texto: 'Olá! Bem-vindo(a) à Empório Hazime. Escolha uma opção:',
      }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).not.toBe('reenviada')
    expect(updates[0]).toMatchObject({ status: 'sent', status_mensagem: 'sent' })
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

  test('Whapi com ID permanece pending quando GET nao encontra registro e nunca e reenviada', async () => {
    const { svc, sendText, getMessages } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ whatsapp_id: 'PspVgQ5Hj3WhapiMessageId123' }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'PspVgQ5Hj3WhapiMessageId123' }))
    expect(getMessages).not.toHaveBeenCalledWith(expect.objectContaining({ referenceId: expect.anything() }))
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('Whapi revalida mensagem sent pelo ID e promove somente pelo ACK consultado', async () => {
    const messageId = 'PspVgQ5Hj3WhapiMessageId123'
    const getMessagesImpl = async (opts) => {
      if (opts.id === messageId) return { ok: true, data: [{ id: messageId, status: 'delivered' }] }
      return { ok: true, data: [] }
    }
    const { svc, sendText, getMessages, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesImpl,
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ status: 'sent', status_mensagem: 'sent', whatsapp_id: messageId }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ id: messageId }))
    expect(updates[0]).toMatchObject({ status: 'delivered', status_mensagem: 'delivered' })
    expect(res.status).toBe('delivered')
  })

  test('Whapi corrige sent legado para pending quando GET do ID confirma pending, sem reenviar', async () => {
    const messageId = 'PspVgQ5Hj3WhapiMessageId123'
    const { svc, sendText, getMessages, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: messageId, status: 'pending' }] },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ status: 'sent', status_mensagem: 'sent', whatsapp_id: messageId }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(updates[0]).toMatchObject({ status: 'pending', status_mensagem: 'sending' })
    expect(res.status).toBe('pending')
  })

  test('Whapi SEM nenhum id dentro da janela de falha mantém pending (eco from_me ainda pode chegar)', async () => {
    const { svc, sendText, getMessages } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    // Sem whatsapp_id/provider_queue_id não há GET /messages/{id} a fazer.
    expect(getMessages).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('Whapi SEM nenhum id após a janela de falha vira erro (fim do relógio eterno), sem reenviar', async () => {
    const { svc, sendText, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ criado_em: new Date(Date.now() - 70 * 60_000).toISOString() }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
    expect(res.action).toBe('patched')
  })

  test('Whapi TEXTO sem id: encontrado no HISTÓRICO do chat → cura (sent + id) sem reenviar', async () => {
    const { svc, sendText, getChatMessages, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [
          { id: 'OUTRA123', from_me: true, body: 'outra coisa', timestamp: Math.floor(Date.now() / 1000) },
          { id: 'WhapiHistMsgId4567890123', from_me: true, body: 'Bom dia, segue o retorno', timestamp: Math.floor(Date.now() / 1000) },
          { id: 'INBOUND1', from_me: false, body: 'Bom dia, segue o retorno', timestamp: Math.floor(Date.now() / 1000) },
        ],
      },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(getChatMessages).toHaveBeenCalledTimes(1)
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('whapi_curada_pelo_historico')
    expect(updates[0]).toMatchObject({ status: 'sent', status_mensagem: 'sent', whatsapp_id: 'WhapiHistMsgId4567890123' })
  })

  test('Whapi RAJADA de textos idênticos: id do histórico já é do IRMÃO → NÃO rouba a cura; reenvia', async () => {
    // Cenário do print do Miguel: "ok" duas vezes no mesmo minuto; a 1ª entregou (dona do id
    // no histórico), a 2ª falhou no POST. Sem a guarda, a 2ª se "curava" com o id da 1ª e o
    // cliente nunca recebia a 2ª mensagem.
    const { svc, sendText, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [
          { id: 'WhapiIrmaoEntregue12345678', from_me: true, body: 'Bom dia, segue o retorno', timestamp: Math.floor(Date.now() / 1000) },
        ],
      },
      donosWhatsappIds: [{ id: 99, whatsapp_id: 'WhapiIrmaoEntregue12345678' }],
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(res.action).toBe('whapi_reenviada_apos_confirmacao_historico')
    expect(updates.some((u) => u.whatsapp_id === 'WhapiIrmaoEntregue12345678')).toBe(false)
  })

  test('Whapi RAJADA de textos idênticos: duas cópias no histórico, uma livre → cura com a LIVRE', async () => {
    const { svc, sendText, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [
          { id: 'WhapiIrmaoEntregue12345678', from_me: true, body: 'Bom dia, segue o retorno', timestamp: Math.floor(Date.now() / 1000) },
          { id: 'WhapiEcoDestaLinha12345678', from_me: true, body: 'Bom dia, segue o retorno', timestamp: Math.floor(Date.now() / 1000) },
        ],
      },
      donosWhatsappIds: [{ id: 99, whatsapp_id: 'WhapiIrmaoEntregue12345678' }],
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('whapi_curada_pelo_historico')
    expect(updates[0]).toMatchObject({ status: 'sent', whatsapp_id: 'WhapiEcoDestaLinha12345678' })
  })

  test('Whapi TEXTO sem id: AUSÊNCIA confirmada no histórico → reenvia 1x (releitura antes)', async () => {
    const { svc, sendText, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'X', from_me: true, body: 'outro texto', timestamp: Math.floor(Date.now() / 1000) }] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(res.action).toBe('whapi_reenviada_apos_confirmacao_historico')
    expect(updates[0]).toMatchObject({ status: 'pending', provider_queue_id: '35097' })
  })

  test('reconciles CONCORRENTES da mesma linha (deferred × sweep) reenviam UMA vez só', async () => {
    const { svc, sendText } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })
    // sendText lento: abre a janela em que a 2ª reconciliação chegava antes do patch da 1ª.
    sendText.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, messageId: '35097' }), 120))
    )

    const [a, b] = await Promise.all([
      svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null }),
      svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null }),
    ])

    expect(sendText).toHaveBeenCalledTimes(1)
    const acoes = [a.action, b.action].sort()
    expect(acoes).toContain('whapi_reenviada_apos_confirmacao_historico')
    expect(acoes).toContain('keep_reenvio_em_andamento')
  })

  test('Whapi TEXTO reenviado com message.id REAL fica pending (id do POST não prova envio)', async () => {
    const { svc, sendText, updates } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })
    sendText.mockResolvedValueOnce({ ok: true, messageId: 'WhapiNovoMsgId4567890123', provider: 'whapi', ackConfirmed: false })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(res.action).toBe('whapi_reenviada_apos_confirmacao_historico')
    expect(updates[0]).toMatchObject({
      status: 'pending',
      status_mensagem: 'sending',
      whatsapp_id: 'WhapiNovoMsgId4567890123',
    })
  })

  test('Whapi TEXTO sem id: eco chegou na CORRIDA (releitura já tem id) → não reenvia', async () => {
    const { svc, sendText } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: 'WhapiEcoMsgId45678901234', provider_queue_id: null },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_eco_na_corrida')
  })

  test('Whapi TEXTO sem id: consulta ao histórico FALHOU → mantém conservador, sem reenviar', async () => {
    const { svc, sendText } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: false, data: [] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })

    const res = await svc.reconcilePendingOutboundMessage(linhaPendente(), { io: null })

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('Whapi MÍDIA sem id: nunca consulta histórico nem reenvia (match por texto não se aplica)', async () => {
    const { svc, sendText, getChatMessages } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [] },
      mensagemNoBanco: { id: 1, status: 'pending', status_mensagem: 'sending', whatsapp_id: null, provider_queue_id: null },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ tipo: 'voice', texto: '(áudio de voz)', url: '/uploads/a.ogg' }),
      { io: null }
    )

    expect(getChatMessages).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('Whapi chatbot (autor null) sem id: não consulta histórico nem reenvia', async () => {
    const { svc, sendText, getChatMessages } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [] },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({ autor_usuario_id: null }),
      { io: null }
    )

    expect(getChatMessages).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('Whapi COM id após a janela de falha continua kept (retenção/indexação do provedor)', async () => {
    const { svc, sendText } = montarAmbiente({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
    })

    const res = await svc.reconcilePendingOutboundMessage(
      linhaPendente({
        whatsapp_id: 'PspVgQ5Hj3WhapiMessageId123',
        criado_em: new Date(Date.now() - 70 * 60_000).toISOString(),
      }),
      { io: null }
    )

    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })
})
