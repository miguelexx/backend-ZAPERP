/**
 * Contrato de buildWebhookReplyMeta (controllers/webhookInbound/replyMeta.js), extraído do miolo de
 * receberZapi na Fase 5 (doc 24). Trava a resolução do reply_meta a partir do payload.
 */

jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => ({
  ...jest.requireActual('../controllers/webhookInbound/whatsappIdLookup'),
  applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
}))

const { buildWebhookReplyMeta } = require('../controllers/webhookInbound/replyMeta')

function fakeSupabase(quotedRow) {
  const q = {
    from: () => q, select: () => q, eq: () => q,
    maybeSingle: () => Promise.resolve({ data: quotedRow, error: null }),
  }
  return q
}
const base = { company_id: 1, conversa_id: 10, whatsapp_instance_id: 5 }

describe('buildWebhookReplyMeta (caracterização)', () => {
  test('sem citação no payload → null', async () => {
    const out = await buildWebhookReplyMeta(fakeSupabase(null), { ...base, payload: { text: { message: 'oi' } } })
    expect(out).toBeNull()
  })

  test('citação encontrada (mensagem out) → name "Você" e snippet do texto citado', async () => {
    const out = await buildWebhookReplyMeta(
      fakeSupabase({ texto: 'mensagem original', direcao: 'out', remetente_nome: null }),
      { ...base, payload: { referenceMessageId: 'WAMID-QUOTED' } }
    )
    expect(out).toMatchObject({ name: 'Você', snippet: 'mensagem original', replyToId: 'WAMID-QUOTED' })
    expect(typeof out.ts).toBe('number')
  })

  test('citação encontrada (in, com remetente) → name = remetente_nome', async () => {
    const out = await buildWebhookReplyMeta(
      fakeSupabase({ texto: 'oi', direcao: 'in', remetente_nome: 'Fulano' }),
      { ...base, payload: { quotedMsgId: 'WAMID-Q2' } }
    )
    expect(out.name).toBe('Fulano')
  })

  test('citação não encontrada no banco → fallback pelo corpo do payload', async () => {
    const out = await buildWebhookReplyMeta(
      fakeSupabase(null),
      { ...base, payload: { referenceMessageId: 'WAMID-X', referencedMessage: { body: 'trecho citado', fromMe: true } } }
    )
    expect(out).toMatchObject({ name: 'Você', snippet: 'trecho citado', replyToId: 'WAMID-X' })
  })
})
