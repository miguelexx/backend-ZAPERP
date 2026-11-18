/**
 * Menu da Triagem Whapi aparecia como "Mensagem" no chat (18/11/2026, conversa 27939).
 *
 * Corrida: o eco `from_me` do menu interativo chegou ANTES de `insertBotBubble` gravar a bolha.
 *  1) o normalizador não lia o corpo de um interactive ENVIADO → texto '' → '(mensagem)';
 *  2) o insert da triagem batia no índice único (conversa_id, whatsapp_id) e era descartado.
 * Resultado: linha tipo='texto', texto='(mensagem)' para sempre.
 */

describe('Whapi — eco do menu interativo enviado (normalizador)', () => {
  const CTX = { channelId: 'CH-1', connectedPhone: '553433334444' }
  afterEach(() => jest.resetModules())

  function normalize(m) {
    return require('../controllers/webhookWhapiController')._test.normalizeWhapiMessageToInternal(m, CTX)
  }

  test('eco from_me de lista interativa traz o texto do corpo (não fica vazio)', () => {
    const n = normalize({
      id: 'PsqJgEiSZaiAP8I-wJCA3q9aeA',
      from_me: true,
      type: 'interactive',
      chat_id: '5534988887777@s.whatsapp.net',
      timestamp: 1795020281,
      interactive: {
        type: 'list',
        body: { text: 'Olá! Seja bem-vindo(a).\nEscolha o setor:' },
        action: { list: { sections: [{ rows: [{ id: 'u1', title: 'Suporte' }] }] } },
      },
    })
    expect(n.body).toBe('Olá! Seja bem-vindo(a).\nEscolha o setor:')
    expect(n.type).toBe('chat')
  })

  test('resposta interativa INBOUND continua usando o título tocado (sem regressão)', () => {
    const n = normalize({
      id: 'in-1',
      from_me: false,
      type: 'reply',
      chat_id: '5534988887777@s.whatsapp.net',
      timestamp: 1795020290,
      reply: { type: 'list_reply', list_reply: { id: 'u1', title: 'Suporte' } },
    })
    expect(n.body).toBe('Suporte')
    expect(n.interactiveReplyId).toBe('u1')
  })

  test('inbound interactive com body NÃO passa a usar o corpo (só from_me)', () => {
    const { extractSentInteractiveBodyText } = require('../controllers/webhookWhapiController')._test
    expect(extractSentInteractiveBodyText({ interactive: { body: 'x' } })).toBe('x')
    const n = normalize({
      id: 'in-2', from_me: false, type: 'interactive', chat_id: '5534988887777@s.whatsapp.net',
      timestamp: 1795020291, interactive: { body: { text: 'corpo de terceiro' } },
    })
    expect(n.body).not.toBe('corpo de terceiro')
  })
})

describe('whapiTriageService.insertBotBubble — eco chegou antes do insert', () => {
  let insertBotBubble

  beforeAll(() => {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({}))
    jest.doMock('../services/chatbotTriageService', () => ({
      transferToDepartment: jest.fn(),
      logBotAction: jest.fn(),
      wasMenuSentForConversa: jest.fn(),
      wasOptionSelectedForConversa: jest.fn(),
    }))
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    insertBotBubble = require('../services/whapiTriage/whapiTriageService')._internal.insertBotBubble
  })
  afterAll(() => jest.resetModules())

  /** Supabase fake: insert dá 23505; select devolve a linha do eco; update registra o patch. */
  function fakeSb(echoRow) {
    const calls = { updates: [] }
    const sb = {
      from() {
        const q = {
          _op: null, _patch: null,
          insert() { q._op = 'insert'; return q },
          update(p) { q._op = 'update'; q._patch = p; calls.updates.push(p); return q },
          select() { if (!q._op) q._op = 'select'; return q },
          eq() { return q },
          maybeSingle: async () => ({ data: echoRow, error: null }),
          single: async () => {
            if (q._op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } }
            if (q._op === 'update') return { data: { ...echoRow, ...q._patch }, error: null }
            return { data: echoRow, error: null }
          },
        }
        return q
      },
    }
    return { sb, calls }
  }

  const sendResult = { ok: true, messageId: 'PsqJgEiSZaiAP8I-wJCA3q9aeA' }
  const replyMeta = { whapi_triage: { mode: 'list', body: 'Menu', options: [{ id: 'u1', title: 'Suporte' }] } }

  test('eco com placeholder: completa texto, tipo e reply_meta, sem tocar no status, e emite', async () => {
    const echo = { id: 9, conversa_id: 1, company_id: 1, texto: '(mensagem)', tipo: 'texto', reply_meta: null, status: 'delivered', direcao: 'out' }
    const { sb, calls } = fakeSb(echo)
    const emitRealtime = jest.fn()
    const row = await insertBotBubble({
      sb, company_id: 1, conversa_id: 1, whatsapp_instance_id: 1,
      texto: 'Menu', tipo: 'interactive', reply_meta: replyMeta, sendResult, emitRealtime,
    })
    expect(calls.updates).toEqual([{ texto: 'Menu', tipo: 'interactive', reply_meta: replyMeta }])
    expect(row).toMatchObject({ id: 9, texto: 'Menu', tipo: 'interactive', status: 'delivered' })
    expect(emitRealtime).toHaveBeenCalledTimes(1)
  })

  test('eco já com o texto real (normalizador novo): só acrescenta tipo/reply_meta', async () => {
    const echo = { id: 9, conversa_id: 1, company_id: 1, texto: 'Menu', tipo: 'texto', reply_meta: null, status: 'read', direcao: 'out' }
    const { sb, calls } = fakeSb(echo)
    await insertBotBubble({
      sb, company_id: 1, conversa_id: 1, texto: 'Menu', tipo: 'interactive', reply_meta: replyMeta, sendResult, emitRealtime: jest.fn(),
    })
    expect(calls.updates).toEqual([{ tipo: 'interactive', reply_meta: replyMeta }])
  })

  test('eco completo: não atualiza nem reemite (nada a corrigir)', async () => {
    const echo = { id: 9, conversa_id: 1, company_id: 1, texto: 'Confirmação', tipo: 'texto', reply_meta: null, status: 'read', direcao: 'out' }
    const { sb, calls } = fakeSb(echo)
    const emitRealtime = jest.fn()
    const row = await insertBotBubble({ sb, company_id: 1, conversa_id: 1, texto: 'Confirmação', sendResult, emitRealtime })
    expect(calls.updates).toEqual([])
    expect(emitRealtime).not.toHaveBeenCalled()
    expect(row).toMatchObject({ id: 9 })
  })

  test('texto real diferente no eco nunca é sobrescrito', async () => {
    const echo = { id: 9, conversa_id: 1, company_id: 1, texto: 'Outro texto', tipo: 'texto', reply_meta: null, status: 'read', direcao: 'out' }
    const { sb, calls } = fakeSb(echo)
    await insertBotBubble({ sb, company_id: 1, conversa_id: 1, texto: 'Menu', tipo: 'interactive', reply_meta: replyMeta, sendResult, emitRealtime: jest.fn() })
    expect(calls.updates).toEqual([])
  })
})
