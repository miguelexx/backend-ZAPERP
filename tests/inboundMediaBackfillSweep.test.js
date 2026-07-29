/**
 * Testes do sweep de segurança: mídia recebida SEM URL deve ser reparada em background,
 * sem o atendente precisar responder. Dedupe por conversa; linhas já com URL são ignoradas.
 */

// Mock do serviço de sync antes de importar o alvo (require lazy dentro do sweep).
jest.mock('../services/oldMessagesSyncService', () => ({
  syncOldMessagesForConversation: jest.fn(async () => ({ ok: true, messagesUpdated: 1, messagesInserted: 0 })),
}))

const { syncOldMessagesForConversation } = require('../services/oldMessagesSyncService')
const { runInboundMediaBackfillSweep } = require('../services/inboundMediaBackfillService')

/**
 * Supabase stub encadeável: cada .from('mensagens') devolve um builder que resolve com a
 * próxima leva de linhas fornecida (1ª chamada = query por texto; 2ª = query por tipo).
 */
function makeSupabase(batchesByCall) {
  let call = 0
  return {
    from() {
      const idx = call
      call += 1
      const builder = {
        select() { return this },
        in() { return this },
        is() { return this },
        gte() { return this },
        order() { return this },
        limit() { return Promise.resolve({ data: batchesByCall[idx] || [], error: null }) },
      }
      return builder
    },
  }
}

beforeEach(() => {
  syncOldMessagesForConversation.mockClear()
  delete process.env.INBOUND_MEDIA_BACKFILL_DISABLED
  delete process.env.INBOUND_MEDIA_BACKFILL_SWEEP_DISABLED
  process.env.INBOUND_MEDIA_BACKFILL_SWEEP_DELAY_MS = '0'
})

test('repara conversas com áudio sem URL e ignora linhas já com URL', async () => {
  const supabase = makeSupabase([
    [
      { id: 1, company_id: 7, conversa_id: 100, tipo: 'texto', texto: '(áudio)', url: null },
      { id: 2, company_id: 7, conversa_id: 100, tipo: 'texto', texto: '(áudio)', url: null }, // mesma conversa → dedupe
      { id: 3, company_id: 7, conversa_id: 200, tipo: 'texto', texto: '(imagem)', url: 'https://s3/x.jpg' }, // já tem URL → ignora
    ],
    [
      { id: 4, company_id: 7, conversa_id: 300, tipo: 'voice', texto: '(áudio)', url: null }, // linha tipada sem URL
    ],
  ])

  const out = await runInboundMediaBackfillSweep(supabase, null)

  // Deve reparar conversas 100 e 300 (uma vez cada); 200 ignorada.
  expect(syncOldMessagesForConversation).toHaveBeenCalledTimes(2)
  const convs = syncOldMessagesForConversation.mock.calls.map((c) => c[1]).sort()
  expect(convs).toEqual([100, 300])
  expect(out.conversationsTriggered).toBe(2)
})

test('desligado por env não faz nada', async () => {
  process.env.INBOUND_MEDIA_BACKFILL_SWEEP_DISABLED = '1'
  const supabase = makeSupabase([[{ id: 1, company_id: 7, conversa_id: 100, tipo: 'texto', texto: '(áudio)', url: null }]])
  const out = await runInboundMediaBackfillSweep(supabase, null)
  expect(syncOldMessagesForConversation).not.toHaveBeenCalled()
  expect(out).toEqual({ scanned: 0, conversationsTriggered: 0 })
})

test('nenhuma mídia sem URL → não dispara reparo', async () => {
  const supabase = makeSupabase([
    [{ id: 1, company_id: 7, conversa_id: 100, tipo: 'imagem', texto: '(imagem)', url: '/uploads/x.jpg' }],
    [],
  ])
  const out = await runInboundMediaBackfillSweep(supabase, null)
  expect(syncOldMessagesForConversation).not.toHaveBeenCalled()
  expect(out.conversationsTriggered).toBe(0)
})
