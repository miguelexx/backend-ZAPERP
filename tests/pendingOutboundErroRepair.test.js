/**
 * REPARO de linhas `erro` que o provedor ACEITOU (tem whatsapp_id).
 *
 * Falha estrutural corrigida: a varredura so olhava `pending`, `sending` e `sent`. Uma vez
 * marcada `erro` — o que acontece quando o prazo PENDING_OUTBOUND_WHAPI_UNACKED_FAIL_MINUTES
 * vence sem ACK — a linha ficava congelada em falha PARA SEMPRE, ainda que no ciclo seguinte o
 * provedor passasse a informar `delivered`/`read`. Na pratica: mensagem entregue e lida pelo
 * cliente exibindo "nao foi possivel enviar" indefinidamente, e o atendente reenviando.
 *
 * Invariante de seguranca testada aqui: reparo NUNCA reenvia. Todo caminho de reenvio exige
 * `provedorNuncaAceitou(row)`, falso quando existe whatsapp_id — e so linhas com id entram.
 */

const ID_REAL = 'PsqS0Txeyym96r8-wDuA3ypkTg'

describe('reparo de erro com id do provedor', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({
    providerName = 'whapi',
    getMessagesResult = { ok: true, data: [] },
    chatHistory = null,
    statusNoBanco = { status: 'erro', status_mensagem: 'failed' },
    whatsappIdNoBanco = ID_REAL,
  } = {}) {
    jest.resetModules()
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'NAO_DEVIA_SER_CHAMADO' }))
    const sendMedia = jest.fn(async () => ({ ok: true, messageId: 'NAO_DEVIA_SER_CHAMADO' }))
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({
        getMessages: jest.fn(async () => getMessagesResult),
        getChatMessages: jest.fn(async () => chatHistory ?? { ok: false, data: [] }),
        sendText,
        sendImage: sendMedia,
        sendFile: sendMedia,
        sendAudio: sendMedia,
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
          not() { return chain },
          in() { return { then(resolve) { resolve({ data: [], error: null }) } } },
          async maybeSingle() {
            if (ctx.update) {
              updates.push({ table, ...ctx.update })
              return { data: { id: 1, company_id: 1, conversa_id: 2, autor_usuario_id: 9 }, error: null }
            }
            if (table === 'conversas') return { data: { id: 2, telefone: '553499911246' }, error: null }
            if (table === 'usuarios') return { data: { nome: 'Miguel', mostrar_nome_ao_cliente: true }, error: null }
            if (table === 'mensagens') {
              return {
                data: { id: 1, ...statusNoBanco, whatsapp_id: whatsappIdNoBanco, provider_queue_id: null },
                error: null,
              }
            }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }))
    const svc = require('../services/pendingOutboundReconciliationService')
    return { svc, sendText, sendMedia, updates }
  }

  const linhaErro = (extra = {}) => ({
    id: 1,
    company_id: 1,
    conversa_id: 2,
    autor_usuario_id: 9,
    direcao: 'out',
    tipo: 'texto',
    texto: 'Bom dia, segue o retorno',
    status: 'erro',
    status_mensagem: 'failed',
    whatsapp_id: ID_REAL,
    provider_queue_id: null,
    criado_em: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...extra,
  })

  test('provedor informa delivered: a linha sai de erro e vira entregue', async () => {
    const { svc, sendText, updates } = montar({
      getMessagesResult: { ok: true, data: [{ id: ID_REAL, status: 'delivered' }] },
    })
    const res = await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(sendText).not.toHaveBeenCalled()
    expect(res.ok).toBe(true)
    expect(updates.map((u) => u.status)).toContain('delivered')
  })

  test('provedor informa read: promove a lida', async () => {
    const { svc, updates } = montar({
      getMessagesResult: { ok: true, data: [{ id: ID_REAL, status: 'read' }] },
    })
    await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(updates.map((u) => u.status)).toContain('read')
  })

  test('GET por id vazio, mas o historico do chat tem o id: cura pelo historico', async () => {
    const { svc, sendText, updates } = montar({
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [
          { id: 'outro', from_me: true, body: 'nada a ver', timestamp: Math.floor(Date.now() / 1000) },
          {
            id: ID_REAL,
            from_me: true,
            body: 'Bom dia, segue o retorno',
            whapi_status_raw: 'read',
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      },
    })
    const res = await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(sendText).not.toHaveBeenCalled()
    expect(String(res.action)).toContain('whapi_historico_por_id')
    expect(updates.map((u) => u.status)).toContain('read')
  })

  test('historico sem status legivel: para de NEGAR o envio, sem inventar entrega', async () => {
    const { svc, updates } = montar({
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [{ id: ID_REAL, from_me: true, body: 'x', timestamp: Math.floor(Date.now() / 1000) }],
      },
    })
    const res = await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(res.action).toBe('whapi_presente_no_historico_por_id')
    expect(updates.map((u) => u.status)).toEqual(['sent'])
    expect(updates.map((u) => u.status)).not.toContain('delivered')
  })

  test('nada no provedor nem no historico: cura a linha para enviada (o id prova que foi aceita)', async () => {
    const { svc, sendText, updates } = montar({
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'outro', from_me: true, body: 'x', timestamp: 1 }] },
    })
    await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(sendText).not.toHaveBeenCalled()
    // "Sem registro" e AUSENCIA DE INFORMACAO, nao recusa: o whatsapp_id so existe porque o
    // provedor aceitou a mensagem. Ate 15/10/2026 a linha ficava em `erro` e a bolha dizia
    // "nao foi possivel enviar" num PDF que o cliente ja tinha aberto. Volta para `sent`.
    expect(updates).toEqual([{ table: 'mensagens', status: 'sent', status_mensagem: 'sent' }])
  })

  test('cura e feita UMA vez: linha ja em sent nao e reescrita a cada ciclo', async () => {
    const { svc, updates } = montar({
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'outro', from_me: true, body: 'x', timestamp: 1 }] },
    })
    await svc.reconcilePendingOutboundMessage(
      { ...linhaErro(), status: 'sent', status_mensagem: 'sent' },
      { io: null }
    )
    expect(updates).toHaveLength(0)
  })

  test('historico informa pending: nao promove nem reprova — espera o ACK', async () => {
    const { svc, updates } = montar({
      getMessagesResult: { ok: true, data: [] },
      chatHistory: {
        ok: true,
        data: [{ id: ID_REAL, from_me: true, body: 'x', whapi_status_raw: 'pending', timestamp: 1 }],
      },
    })
    await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(updates.filter((u) => ['sent', 'delivered', 'read'].includes(u.status))).toHaveLength(0)
    // ...e tambem nao marca falha: o provedor ACEITOU a mensagem, so nao a entregou ainda.
    // Inventar qualquer desfecho aqui mente para um dos lados — a linha espera o ACK.
    expect(updates.filter((u) => ['erro', 'failed'].includes(u.status))).toHaveLength(0)
  })

  test('erro SEM id do provedor nao entra no reparo (nunca pode ser reenviado por ele)', async () => {
    const { svc, sendText } = montar({ whatsappIdNoBanco: null })
    const res = await svc.reconcilePendingOutboundMessage(
      linhaErro({ whatsapp_id: null }), { io: null },
    )
    expect(res.action).toBe('skip_not_pending')
    expect(sendText).not.toHaveBeenCalled()
  })

  test('queue id numerico da UltraMSG nao conta como id real', async () => {
    const { svc } = montar({ providerName: 'whapi' })
    const res = await svc.reconcilePendingOutboundMessage(
      linhaErro({ whatsapp_id: '35096' }), { io: null },
    )
    expect(res.action).toBe('skip_not_pending')
  })

  test('UltraMSG mantem o comportamento historico: erro nao e reexaminado', async () => {
    const { svc, sendText } = montar({ providerName: 'ultramsg' })
    const res = await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(res.action).toBe('skip_erro_non_whapi')
    expect(sendText).not.toHaveBeenCalled()
  })

  test('midia em erro com id tambem e reparavel, e sem reenviar', async () => {
    const { svc, sendMedia, updates } = montar({
      getMessagesResult: { ok: true, data: [{ id: ID_REAL, status: 'delivered' }] },
    })
    await svc.reconcilePendingOutboundMessage(
      linhaErro({ tipo: 'imagem', url: '/uploads/x.jpg', nome_arquivo: 'x.jpg' }), { io: null },
    )
    expect(sendMedia).not.toHaveBeenCalled()
    expect(updates.map((u) => u.status)).toContain('delivered')
  })

  test('provedor informa falha de verdade: continua erro', async () => {
    const { svc, updates } = montar({
      getMessagesResult: { ok: true, data: [{ id: ID_REAL, status: 'failed' }] },
    })
    await svc.reconcilePendingOutboundMessage(linhaErro(), { io: null })
    expect(updates.filter((u) => ['sent', 'delivered', 'read'].includes(u.status))).toHaveLength(0)
  })
})

describe('guarda de nao-regressao com erro', () => {
  test('promover erro para read e permitido; reescrever erro sobre erro nao', async () => {
    jest.resetModules()
    const statusDoBanco = { valor: { status: 'erro', status_mensagem: 'failed' } }
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../config/supabase', () => ({
      from() {
        const ctx = { update: null }
        const chain = {
          update(p) { ctx.update = p; return chain },
          select() { return chain },
          eq() { return chain },
          not() { return chain },
          in() { return { then(r) { r({ data: [], error: null }) } } },
          async maybeSingle() {
            if (ctx.update) return { data: { id: 1, company_id: 1, conversa_id: 2 }, error: null }
            return { data: { id: 1, ...statusDoBanco.valor }, error: null }
          },
        }
        return chain
      },
    }))
    const { _test } = require('../services/pendingOutboundReconciliationService')
    const row = { id: 1, company_id: 1 }
    expect(await _test.statusJaMaisAvancado(row, { status: 'erro' })).toBe(true)
    expect(await _test.statusJaMaisAvancado(row, { status: 'read' })).toBe(false)
    expect(await _test.statusJaMaisAvancado(row, { status: 'delivered' })).toBe(false)
    expect(await _test.statusJaMaisAvancado(row, { status: 'sent' })).toBe(false)

    statusDoBanco.valor = { status: 'read', status_mensagem: 'read' }
    // Linha ja lida nunca regride para erro nem para pending.
    expect(await _test.statusJaMaisAvancado(row, { status: 'erro' })).toBe(true)
    expect(await _test.statusJaMaisAvancado(row, { status: 'pending' })).toBe(true)
  })
})
