/**
 * Invariante crítico do webhook: ACK sem REGRESSÃO. Trava `resolveEffectiveStatus`
 * (controllers/webhookInbound/statusApply.js), extraído do miolo de receberZapi na Fase 5 (doc 24).
 * Ranking real: pending<sent<delivered<read<played; erro/failed = -1.
 */

// Mocka os acessos a banco do sibling para exercitar applyAckStatusByWaId sem Supabase real.
jest.mock('../controllers/webhookInbound/whatsappIdLookup', () => ({
  ...jest.requireActual('../controllers/webhookInbound/whatsappIdLookup'),
  selectSingleMensagemByWhatsappId: jest.fn(),
  patchMensagemStatusById: jest.fn(),
}))

const { resolveEffectiveStatus, applyAckStatusByWaId } = require('../controllers/webhookInbound/statusApply')
const { selectSingleMensagemByWhatsappId, patchMensagemStatusById } = require('../controllers/webhookInbound/whatsappIdLookup')

describe('resolveEffectiveStatus — ACK sem regressão (caracterização)', () => {
  test('não rebaixa: read + delivered atrasado → read', () => {
    expect(resolveEffectiveStatus('read', 'delivered')).toBe('read')
  })

  test('promove: sent + delivered → delivered; delivered + read → read', () => {
    expect(resolveEffectiveStatus('sent', 'delivered')).toBe('delivered')
    expect(resolveEffectiveStatus('delivered', 'read')).toBe('read')
  })

  test('played é o topo: played + read → played', () => {
    expect(resolveEffectiveStatus('played', 'read')).toBe('played')
  })

  test('falha tardia NÃO apaga entrega/leitura: read/delivered + erro → mantém', () => {
    expect(resolveEffectiveStatus('read', 'erro')).toBe('read')
    expect(resolveEffectiveStatus('delivered', 'failed')).toBe('delivered')
  })

  test('falha antes de delivered vence: sent + erro → erro', () => {
    expect(resolveEffectiveStatus('sent', 'erro')).toBe('erro')
  })

  test('current nulo vira pending: null + sent → sent; null + erro → erro', () => {
    expect(resolveEffectiveStatus(null, 'sent')).toBe('sent')
    expect(resolveEffectiveStatus(null, 'erro')).toBe('erro')
  })
})

describe('applyAckStatusByWaId — update por whatsapp_id (I/O com mocks)', () => {
  const ctx = { company_id: 1, whatsapp_instance_id: 5 }
  beforeEach(() => jest.clearAllMocks())

  test('mensagem encontrada (sent) + read → faz patch com effectiveStatus read e devolve a linha', async () => {
    selectSingleMensagemByWhatsappId.mockResolvedValue({ data: { id: 42, status: 'sent' }, error: null, ambiguous: false })
    patchMensagemStatusById.mockResolvedValue({ data: { id: 42, status_mensagem: 'read' }, error: null })
    const out = await applyAckStatusByWaId({}, ctx, 'WAMID-1', 'read')
    expect(patchMensagemStatusById).toHaveBeenCalledWith({}, expect.objectContaining({ mensagem_id: 42, effectiveStatus: 'read', whatsapp_id: 'WAMID-1' }))
    expect(out).toMatchObject({ id: 42, whatsapp_id: 'WAMID-1', _effective_status: 'read' })
  })

  test('não regride: mensagem read + delivered atrasado → patch com effectiveStatus read', async () => {
    selectSingleMensagemByWhatsappId.mockResolvedValue({ data: { id: 42, status: 'read' }, error: null, ambiguous: false })
    patchMensagemStatusById.mockResolvedValue({ data: { id: 42 }, error: null })
    await applyAckStatusByWaId({}, ctx, 'WAMID-1', 'delivered')
    expect(patchMensagemStatusById).toHaveBeenCalledWith({}, expect.objectContaining({ effectiveStatus: 'read' }))
  })

  test('mensagem não encontrada → null (sem patch)', async () => {
    selectSingleMensagemByWhatsappId.mockResolvedValue({ data: null, error: null, ambiguous: false })
    const out = await applyAckStatusByWaId({}, ctx, 'WAMID-X', 'read')
    expect(out).toBeNull()
    expect(patchMensagemStatusById).not.toHaveBeenCalled()
  })

  test('waId/status vazio → null sem consultar o banco', async () => {
    expect(await applyAckStatusByWaId({}, ctx, '', 'read')).toBeNull()
    expect(await applyAckStatusByWaId({}, ctx, 'WAMID-1', '')).toBeNull()
    expect(selectSingleMensagemByWhatsappId).not.toHaveBeenCalled()
  })

  test('returnResult:true → devolve envelope {data,error,ambiguous,effectiveStatus}', async () => {
    selectSingleMensagemByWhatsappId.mockResolvedValue({ data: null, error: null, ambiguous: true })
    const out = await applyAckStatusByWaId({}, ctx, 'WAMID-1', 'read', { returnResult: true })
    expect(out).toMatchObject({ data: null, ambiguous: true, effectiveStatus: 'read' })
  })
})
