/**
 * Testes unitários — emissão Socket.IO do módulo Disparo (Etapa 7).
 */

const { emitDisparo, EVENTS } = require('../services/disparoSocketService')

function mockIo() {
  const emit = jest.fn()
  const to = jest.fn(() => ({ emit }))
  return { to, emit, _emit: emit }
}

describe('disparoSocketService — emitDisparo', () => {
  it('emite só para sala empresa_{companyId}', () => {
    const io = mockIo()
    emitDisparo(io, 10, EVENTS.CAMPANHA_INICIADA, { campanha_id: 5 })

    expect(io.to).toHaveBeenCalledTimes(1)
    expect(io.to).toHaveBeenCalledWith('empresa_10')
    expect(io._emit).toHaveBeenCalledWith(
      EVENTS.CAMPANHA_INICIADA,
      expect.objectContaining({
        campanha_id: 5,
        company_id: 10,
        ts: expect.any(String),
      }),
    )
  })

  it('normaliza companyId numérico na sala e no payload', () => {
    const io = mockIo()
    emitDisparo(io, '42', EVENTS.ITEM_ATUALIZADO, { item_id: 1 })

    expect(io.to).toHaveBeenCalledWith('empresa_42')
    expect(io._emit).toHaveBeenCalledWith(
      EVENTS.ITEM_ATUALIZADO,
      expect.objectContaining({ company_id: 42 }),
    )
  })

  it('não emite sem io', () => {
    expect(() => emitDisparo(null, 10, EVENTS.CAMPANHA_PAUSADA, {})).not.toThrow()
  })

  it('não emite sem companyId', () => {
    const io = mockIo()
    emitDisparo(io, null, EVENTS.CAMPANHA_PAUSADA, {})
    emitDisparo(io, 0, EVENTS.CAMPANHA_PAUSADA, {})
    emitDisparo(io, undefined, EVENTS.CAMPANHA_PAUSADA, {})

    expect(io.to).not.toHaveBeenCalled()
    expect(io._emit).not.toHaveBeenCalled()
  })

  it('preserva payload original e adiciona metadados', () => {
    const io = mockIo()
    emitDisparo(io, 7, EVENTS.LIMITE_ATINGIDO, {
      campanha_id: 3,
      motivo: 'Limite diário',
    })

    expect(io._emit).toHaveBeenCalledWith(
      EVENTS.LIMITE_ATINGIDO,
      expect.objectContaining({
        campanha_id: 3,
        motivo: 'Limite diário',
        company_id: 7,
      }),
    )
  })

  it('EVENTS contém eventos esperados da Etapa 7', () => {
    expect(EVENTS).toMatchObject({
      CAMPANHA_INICIADA: 'disparo_campanha_iniciada',
      CAMPANHA_PAUSADA: 'disparo_campanha_pausada',
      ITEM_ATUALIZADO: 'disparo_item_atualizado',
      LIMITE_ATINGIDO: 'disparo_limite_atingido',
    })
  })
})
