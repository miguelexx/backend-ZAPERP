/**
 * Testes unitários — hook de webhook UltraMSG → fila Disparo (Etapa 7).
 */

jest.mock('../services/disparoFilaService', () => ({
  recalcularContadores: jest.fn().mockResolvedValue({}),
}))

const supabase = require('../config/supabase')
const { recalcularContadores } = require('../services/disparoFilaService')
const {
  aplicarStatusDisparoFromWebhook,
  mapAckToFilaStatus,
} = require('../services/disparoWebhookHook')

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = ['select', 'eq', 'update']
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const itemEnviada = {
  id: 42,
  company_id: 10,
  campanha_id: 1,
  execucao_id: 50,
  status: 'enviada',
  reference_id: 'disp-42',
  provider_message_id: 'wamid-1',
}

describe('disparoWebhookHook — mapAckToFilaStatus', () => {
  it('mapeia ACKs UltraMSG para status da fila', () => {
    expect(mapAckToFilaStatus('sent')).toBe('enviada')
    expect(mapAckToFilaStatus('delivered')).toBe('entregue')
    expect(mapAckToFilaStatus('read')).toBe('lida')
    expect(mapAckToFilaStatus('played')).toBe('lida')
    expect(mapAckToFilaStatus('failed')).toBe('falhou')
  })

  it('status desconhecido → null', () => {
    expect(mapAckToFilaStatus('xyz')).toBeNull()
  })
})

describe('disparoWebhookHook — aplicarStatusDisparoFromWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('ignora referências que não são disp-', async () => {
    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'msg-123',
      status: 'delivered',
      companyId: 10,
    })
    expect(r.ok).toBe(false)
    expect(r.ignored).toBe('not_disp_reference')
  })

  it('avança status enviada → entregue', async () => {
    let updatePayload = null
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_fila_itens') {
        const selectChain = mockChain({ data: itemEnviada, error: null })
        const updateChain = mockChain({
          data: { ...itemEnviada, status: 'entregue' },
          error: null,
        })
        updateChain.update = jest.fn((payload) => {
          updatePayload = payload
          return updateChain
        })
        let callCount = 0
        return {
          select: jest.fn(() => selectChain),
          update: updateChain.update,
          eq: jest.fn(function eq() {
            callCount += 1
            if (callCount > 2) return updateChain
            return this || updateChain
          }),
        }
      }
      return mockChain()
    })

    const io = { to: jest.fn(() => ({ emit: jest.fn() })) }
    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'disp-42',
      status: 'delivered',
      companyId: 10,
      io,
    })

    expect(r.ok).toBe(true)
    expect(r.status).toBe('entregue')
    expect(updatePayload?.status).toBe('entregue')
    expect(updatePayload?.entregue_em).toBeTruthy()
    expect(recalcularContadores).toHaveBeenCalledWith(50, 10)
  })

  it('duplicado/idempotente: mesmo status não regride', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: { ...itemEnviada, status: 'entregue' }, error: null }),
    )

    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'disp-42',
      status: 'sent',
      companyId: 10,
    })

    expect(r.ok).toBe(true)
    expect(r.ignored).toBe('status_no_upgrade')
    expect(r.status_atual).toBe('entregue')
    expect(r.status_recebido).toBe('enviada')
  })

  it('fora de ordem: entregue não regride para enviada', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: { ...itemEnviada, status: 'entregue' }, error: null }),
    )

    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'disp-42',
      status: 'sent',
      companyId: 10,
    })

    expect(r.ignored).toBe('status_no_upgrade')
  })

  it('lida é terminal — read duplicado não altera', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: { ...itemEnviada, status: 'lida' }, error: null }),
    )

    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'disp-42',
      status: 'delivered',
      companyId: 10,
    })

    expect(r.ignored).toBe('status_no_upgrade')
  })

  it('item não encontrado → ignored', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: null, error: null }),
    )

    const r = await aplicarStatusDisparoFromWebhook({
      referenceId: 'disp-999',
      status: 'delivered',
      companyId: 10,
    })

    expect(r.ok).toBe(false)
    expect(r.ignored).toBe('item_not_found')
  })
})
