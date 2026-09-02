/**
 * Contrato de reconcileFromMeInReceived (controllers/webhookInbound/fromMeReceivedReconcile.js),
 * extraído do miolo de receberZapi na Fase 5 (doc 24). Trava os desfechos principais; o caminho
 * profundo de candidato-por-mídia é verbatim + verificado por scanner de imports + gate e2e (teste B).
 */

// Controla o reconcile por referenceId e o matcher de candidato (siblings de webhookInbound).
jest.mock('../controllers/webhookInbound/fromMeReconcile', () => ({
  ...jest.requireActual('../controllers/webhookInbound/fromMeReconcile'),
  tryReconcileFromMeByCrmReferenceId: jest.fn(),
  findFromMeOutboundMediaCandidate: jest.fn(() => null),
}))

const { tryReconcileFromMeByCrmReferenceId } = require('../controllers/webhookInbound/fromMeReconcile')
const { reconcileFromMeInReceived } = require('../controllers/webhookInbound/fromMeReceivedReconcile')

// Fake supabase thenable: as buscas de candidato resolvem para lista vazia.
function fakeSupabaseEmpty() {
  const q = {
    from: () => q, select: () => q, eq: () => q, order: () => q, limit: () => q,
    gte: () => q, lte: () => q, update: () => q,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res) => res({ data: [] }),
  }
  return q
}
const ctx = {
  company_id: 1, conversa_id: 10, whatsapp_instance_id: 5, payload: {}, whatsappIdStr: 'WAMID-1',
  type: 'text', criado_em: '2026-09-01T00:00:00Z', texto: 'oi', io: null,
}

describe('reconcileFromMeInReceived (caracterização)', () => {
  beforeEach(() => jest.clearAllMocks())

  test('crm-ref casa → devolve a mensagem reconciliada sem buscar candidato', async () => {
    tryReconcileFromMeByCrmReferenceId.mockResolvedValue({ id: 55, direcao: 'in', status: 'sent' })
    const out = await reconcileFromMeInReceived(fakeSupabaseEmpty(), ctx)
    expect(out).toMatchObject({ id: 55 })
  })

  test('crm-ref não casa e nenhum candidato → devolve null', async () => {
    tryReconcileFromMeByCrmReferenceId.mockResolvedValue(null)
    const out = await reconcileFromMeInReceived(fakeSupabaseEmpty(), ctx)
    expect(out).toBeNull()
  })

  test('erro interno é engolido (best-effort) → devolve null, não lança', async () => {
    tryReconcileFromMeByCrmReferenceId.mockRejectedValue(new Error('boom'))
    const out = await reconcileFromMeInReceived(fakeSupabaseEmpty(), ctx)
    expect(out).toBeNull()
  })
})
