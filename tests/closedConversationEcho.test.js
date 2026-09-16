const {
  rememberClosedConversation,
  getRecentClosedConversation,
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

describe('recentClosedConversationGuard + detectOwnOutboundEcho', () => {
  beforeEach(() => {
    resetRecentClosedConversationsForTests()
  })

  test('lembra o texto de finalização na corrida do webhook', () => {
    rememberClosedConversation({
      companyId: 7,
      conversaId: 99,
      texto: 'Atendimento finalizado com sucesso. Segue seu protocolo: *12*.',
    })
    const rec = getRecentClosedConversation(7, 99)
    expect(rec.texts[0]).toContain('protocolo')
  })

  test('detecta eco pela memória mesmo sem linha outbound no banco', async () => {
    const msg = 'Atendimento finalizado com sucesso. Segue seu protocolo: *63902*.'
    rememberClosedConversation({ companyId: 1, conversaId: 10, texto: msg })
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase(),
      company_id: 1,
      conversa_id: 10,
      texto: msg,
      messageId: 'true_5534@c.us_ABC',
    })
    expect(r.isEcho).toBe(true)
  })

  test('detecta eco da última outbound já persistida', async () => {
    const agente = 'Resolvido por ligação. Cliente estava acessando dentro do servidor, e a tef funciona somente fora.'
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({ outboundTexts: [agente] }),
      company_id: 1,
      conversa_id: 10,
      texto: agente,
    })
    expect(r.isEcho).toBe(true)
    expect(r.reason).toBe('echo_recent_outbound')
  })

  test('não trata demanda nova como eco', async () => {
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({
        outboundTexts: ['Atendimento finalizado com sucesso. Segue seu protocolo: *1*.'],
      }),
      company_id: 1,
      conversa_id: 10,
      texto: 'Preciso de ajuda com outro pedido',
    })
    expect(r.isEcho).toBe(false)
  })

  test('whatsapp_id já gravado como outbound é eco', async () => {
    const r = await detectOwnOutboundEcho({
      supabase: mockSupabase({ outboundByWaId: { id: 55, direcao: 'out' } }),
      company_id: 1,
      conversa_id: 10,
      texto: 'qualquer',
      messageId: 'wamid.OUT',
    })
    expect(r.isEcho).toBe(true)
    expect(r.reason).toBe('whatsapp_id_outbound')
  })
})
