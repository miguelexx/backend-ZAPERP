/**
 * Conferência DIFERIDA (~90s após o envio) do status de uma mensagem.
 *
 * Bug corrigido: a busca aplicava a carência de 3 min também quando vinha um mensagemId, então
 * a conferência de 90s nunca achava a própria linha e virava no-op — sem ACK, o tique só andava
 * na varredura (3 a 8 min). Agora a carência vale só para a varredura; e, dentro da carência, a
 * conferência pode CONFIRMAR status mas nunca REENVIAR.
 */

describe('conferência diferida do status', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montarBusca() {
    jest.resetModules()
    const chamadas = []
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => 'whapi'),
    }))
    jest.doMock('../config/supabase', () => ({
      from(table) {
        const reg = { table, lte: false, idFiltrado: false }
        chamadas.push(reg)
        const chain = {
          select() { return chain },
          eq(col) { if (col === 'id') reg.idFiltrado = true; return chain },
          in() { return chain },
          gte() { return chain },
          gt() { return chain },
          lte() { reg.lte = true; return chain },
          order() { return chain },
          limit() { return chain },
          then(resolve) { resolve({ data: [], error: null }) },
        }
        return chain
      },
    }))
    const svc = require('../services/pendingOutboundReconciliationService')
    return { svc, chamadas }
  }

  test('com mensagemId a busca NÃO aplica a carência (a linha de 90s é encontrada)', async () => {
    const { svc, chamadas } = montarBusca()
    await svc.runPendingOutboundReconciliation({ companyId: 1, mensagemId: 55 })
    const buscasMensagens = chamadas.filter((c) => c.table === 'mensagens')
    expect(buscasMensagens.length).toBeGreaterThan(0)
    expect(buscasMensagens.every((c) => c.idFiltrado)).toBe(true)
    expect(buscasMensagens.some((c) => c.lte)).toBe(false)
  })

  test('a VARREDURA (sem mensagemId) continua aplicando a carência', async () => {
    const { svc, chamadas } = montarBusca()
    await svc.runPendingOutboundReconciliation({})
    const buscasMensagens = chamadas.filter((c) => c.table === 'mensagens')
    expect(buscasMensagens.length).toBeGreaterThan(0)
    expect(buscasMensagens.every((c) => c.lte)).toBe(true)
  })

  function montarReconcile({ providerName, getMessagesResult, chatHistory, statusNoBanco = { status: 'pending', status_mensagem: 'sending' } }) {
    jest.resetModules()
    const sendText = jest.fn(async () => ({ ok: true, messageId: '35097' }))
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({
        getMessages: jest.fn(async () => getMessagesResult),
        getChatMessages: jest.fn(async () => chatHistory ?? { ok: false, data: [] }),
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
          in() { return { then(resolve) { resolve({ data: [], error: null }) } } },
          async maybeSingle() {
            if (ctx.update) {
              updates.push({ table, ...ctx.update })
              return { data: { id: 1, company_id: 1, conversa_id: 2, autor_usuario_id: 9 }, error: null }
            }
            if (table === 'conversas') return { data: { id: 2, telefone: '5511999999999' }, error: null }
            if (table === 'usuarios') return { data: { nome: 'Miguel', mostrar_nome_ao_cliente: true }, error: null }
            if (table === 'mensagens') {
              return { data: { id: 1, ...statusNoBanco, whatsapp_id: null, provider_queue_id: null }, error: null }
            }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }))
    const svc = require('../services/pendingOutboundReconciliationService')
    return { svc, sendText, updates }
  }

  const linha = (extra = {}) => ({
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
    criado_em: new Date(Date.now() - 90_000).toISOString(),
    ...extra,
  })

  test('Whapi sem id, 90s, ausente no histórico → NÃO reenvia dentro da carência', async () => {
    const { svc, sendText } = montarReconcile({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'X', from_me: true, body: 'outro texto', timestamp: Math.floor(Date.now() / 1000) }] },
    })
    const res = await svc.reconcilePendingOutboundMessage(linha(), { io: null, force: true })
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_whapi_unconfirmed')
  })

  test('UltraMSG sem registro no provedor, 90s → NÃO reenvia dentro da carência', async () => {
    const { svc, sendText } = montarReconcile({
      providerName: 'ultramsg',
      getMessagesResult: { ok: true, data: [] },
    })
    const res = await svc.reconcilePendingOutboundMessage(linha(), { io: null, force: true })
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('keep_waiting')
  })

  test('Whapi com id, 90s: provedor já informa delivered → tique sobe sem esperar a varredura', async () => {
    const { svc, sendText, updates } = montarReconcile({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: 'PsrIhlIPnArSqck-wOuAzLILsg', status: 'delivered' }] },
    })
    const res = await svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg' }),
      { io: null, force: true }
    )
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('patched')
    expect(updates[0]).toMatchObject({ status: 'delivered', status_mensagem: 'delivered' })
  })

  test('ACK read chegou durante a consulta: provedor devolve delivered → NÃO rebaixa o tique', async () => {
    const { svc, updates } = montarReconcile({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: 'PsrIhlIPnArSqck-wOuAzLILsg', status: 'delivered' }] },
      statusNoBanco: { status: 'read', status_mensagem: 'read' },
    })
    const res = await svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg' }),
      { io: null, force: true }
    )
    expect(res.action).toBe('keep_status_mais_avancado')
    expect(updates).toHaveLength(0)
  })

  test('provedor informa falha, mas a linha já consta entregue → não vira erro', async () => {
    const { svc, updates } = montarReconcile({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: 'PsrIhlIPnArSqck-wOuAzLILsg', status: 'failed' }] },
      statusNoBanco: { status: 'delivered', status_mensagem: 'delivered' },
    })
    const res = await svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg' }),
      { io: null, force: true }
    )
    expect(res.action).toBe('keep_status_mais_avancado')
    expect(updates).toHaveLength(0)
  })

  test('provedor informa falha e a linha segue pendente → marca erro (comportamento preservado)', async () => {
    const { svc, updates } = montarReconcile({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: 'PsrIhlIPnArSqck-wOuAzLILsg', status: 'failed' }] },
    })
    await svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg' }),
      { io: null, force: true }
    )
    expect(updates[0]).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
  })
})
