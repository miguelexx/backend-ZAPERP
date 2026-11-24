/**
 * Realtime do envio: quando o "aguardando cliente" NÃO é marcado, o payload repassa o valor
 * gravado para o frontend desfazer a previsão otimista (24/11/2026).
 */
jest.mock('../services/atendimentoModoSimplesService', () => ({
  aplicarModoSimplesNoPayload: jest.fn((payload) => payload),
  recalcularStatusPorUltimaMensagem: jest.fn(),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirConversaAtualizada: jest.fn(),
}))

const { aplicarAguardandoClienteNoPayload } = require('../services/chat/outbound/modoSimplesOutbound')

describe('aplicarAguardandoClienteNoPayload', () => {
  it('marcado: em_atendimento + aguardando_cliente_desde', () => {
    const p = aplicarAguardandoClienteNoPayload({ id: 1 }, { marked: true, aguardando_cliente_desde: 'T1' }, {})
    expect(p).toMatchObject({ status_atendimento: 'em_atendimento', aguardando_cliente_desde: 'T1', exibir_badge_aberta: false })
  })

  it('não marcado (msg de ausência): repassa o valor gravado, inclusive null', () => {
    const p = aplicarAguardandoClienteNoPayload(
      { id: 1 },
      { marked: false, reason: 'message_not_qualified', aguardando_cliente_desde_atual: null },
      {}
    )
    expect(p).toHaveProperty('aguardando_cliente_desde', null)
    expect(p).not.toHaveProperty('status_atendimento')
  })

  it('não marcado mas já aguardava: mantém o timestamp anterior', () => {
    const p = aplicarAguardandoClienteNoPayload(
      { id: 1 },
      { marked: false, reason: 'not_in_human_attendance', aguardando_cliente_desde_atual: 'T0' },
      {}
    )
    expect(p.aguardando_cliente_desde).toBe('T0')
  })

  it('sem resultado (modo simples / erro): não inventa o campo', () => {
    const p = aplicarAguardandoClienteNoPayload({ id: 1 }, null, {})
    expect(p).not.toHaveProperty('aguardando_cliente_desde')
  })
})

describe('linhaRealtimeAssumirNoEnvio (assumir dentro do envio)', () => {
  const { linhaRealtimeAssumirNoEnvio } = jest.requireActual('../services/chat/access/conversationPolicy')

  it('omite aguardando_cliente_desde=null para não apagar a previsão do frontend', () => {
    const out = linhaRealtimeAssumirNoEnvio({ id: 1, status_atendimento: 'em_atendimento', atendente_id: 4, aguardando_cliente_desde: null })
    expect(out).not.toHaveProperty('aguardando_cliente_desde')
    expect(out).toMatchObject({ id: 1, status_atendimento: 'em_atendimento', atendente_id: 4 })
  })

  it('mantém o valor quando ele existe', () => {
    const row = { id: 1, aguardando_cliente_desde: 'T0' }
    expect(linhaRealtimeAssumirNoEnvio(row)).toBe(row)
  })
})
