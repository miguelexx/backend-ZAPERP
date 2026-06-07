const {
  overridesFromListQuery,
  parseConversaIdsQuery,
  getStartOfTodayIso,
  getEndOfTodayIso,
} = require('../services/chatListCountsService')

describe('chatListCountsService', () => {
  test('parseConversaIdsQuery parses comma-separated ids', () => {
    expect(parseConversaIdsQuery('1,2, 3')).toEqual([1, 2, 3])
    expect(parseConversaIdsQuery('0')).toEqual([])
    expect(parseConversaIdsQuery('')).toEqual([])
  })

  test('overridesFromListQuery maps active list filters', () => {
    expect(overridesFromListQuery({ conversa_ids: '10,11' })).toEqual({ conversa_ids: [10, 11] })
    expect(overridesFromListQuery({ conversa_ids: '0' })).toEqual({ conversa_ids: [0] })
    expect(overridesFromListQuery({ minha_fila: '1' })).toEqual({ minha_fila: true })
    expect(overridesFromListQuery({ hoje: '1' })).toEqual({ hoje: true })
    expect(overridesFromListQuery({ aguardando_cliente: '1' })).toEqual({ aguardando_cliente: true })
    expect(overridesFromListQuery({ status_atendimento: 'fechada' })).toEqual({
      status_atendimento: 'fechada',
    })
    expect(
      overridesFromListQuery({
        status_atendimento: 'fechada',
        finalizacao_motivo: 'ausencia_cliente',
      })
    ).toEqual({
      status_atendimento: 'fechada',
      finalizacao_motivo: 'ausencia_cliente',
    })
    expect(overridesFromListQuery({})).toEqual({})
  })

  test('today bounds cover full local calendar day', () => {
    const start = new Date(getStartOfTodayIso())
    const end = new Date(getEndOfTodayIso())
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
    expect(end.getTime()).toBeGreaterThan(start.getTime())
  })
})
