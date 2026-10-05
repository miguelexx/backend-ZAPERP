const {
  normalizeRawAckStatus,
  normalizeMessageAckStatus,
  canonStatusForEmit,
  statusRank,
} = require('../helpers/messageStatusHelper')

describe('messageStatusHelper', () => {
  test('normalizeRawAckStatus mapeia UltraMSG device→delivered e server→sent', () => {
    expect(normalizeRawAckStatus('device')).toBe('delivered')
    expect(normalizeRawAckStatus('server')).toBe('sent')
    expect(normalizeRawAckStatus('pending')).toBe('pending')
    expect(normalizeRawAckStatus('2')).toBe('delivered')
  })

  test('normalizeMessageAckStatus prioriza body.status já mapeado', () => {
    expect(normalizeMessageAckStatus({ ack: 'device', status: 'delivered' })).toBe('delivered')
    expect(normalizeMessageAckStatus({ ack: 'server', status: 'sent' })).toBe('sent')
  })

  test('normalizeMessageAckStatus mapeia ack bruto quando status ausente', () => {
    expect(normalizeMessageAckStatus({ ack: 'device' })).toBe('delivered')
    expect(normalizeMessageAckStatus({ ack: 'server' })).toBe('sent')
  })

  test('canonStatusForEmit normaliza aliases', () => {
    expect(canonStatusForEmit('device')).toBe('delivered')
    expect(canonStatusForEmit('enviada')).toBe('sent')
  })

  test('statusRank ordena progresso de ticks', () => {
    expect(statusRank('delivered')).toBeGreaterThan(statusRank('sent'))
    expect(statusRank('read')).toBeGreaterThan(statusRank('delivered'))
  })

  describe('resolveAckEffectiveStatus', () => {
    const { resolveAckEffectiveStatus } = require('../helpers/messageStatusHelper')

    test('ack atrasado não regride status mais avançado', () => {
      expect(resolveAckEffectiveStatus('read', 'delivered')).toBe('read')
      expect(resolveAckEffectiveStatus('delivered', 'sent')).toBe('delivered')
    })

    test('ack mais avançado aplica normalmente', () => {
      expect(resolveAckEffectiveStatus('sent', 'delivered')).toBe('delivered')
      expect(resolveAckEffectiveStatus('pending', 'sent')).toBe('sent')
    })

    test('ACK de falha explícita (failed/erro) APLICA sobre pending/sending', () => {
      // Antes o rank -1 do erro era engolido pelo guard e a bolha ficava no relógio para sempre.
      expect(resolveAckEffectiveStatus('pending', 'erro')).toBe('erro')
      expect(resolveAckEffectiveStatus('sending', 'erro')).toBe('erro')
      expect(resolveAckEffectiveStatus('pending', 'failed')).toBe('erro')
      expect(resolveAckEffectiveStatus(null, 'erro')).toBe('erro')
    })

    test('ACK de falha NÃO regride mensagem já confirmada (sent/delivered/read)', () => {
      expect(resolveAckEffectiveStatus('sent', 'erro')).toBe('sent')
      expect(resolveAckEffectiveStatus('delivered', 'failed')).toBe('delivered')
      expect(resolveAckEffectiveStatus('read', 'erro')).toBe('read')
    })

    test('ACKs fora de ordem: sucesso tardio recupera erro; played não regride', () => {
      // Linha marcada erro (ex.: failed engolido cedo demais) + ACK sent/delivered real depois:
      // o provedor confirmou o envio — a recuperação vence o erro.
      expect(resolveAckEffectiveStatus('erro', 'sent')).toBe('sent')
      expect(resolveAckEffectiveStatus('erro', 'delivered')).toBe('delivered')
      expect(resolveAckEffectiveStatus('played', 'read')).toBe('played')
      expect(resolveAckEffectiveStatus('played', 'delivered')).toBe('played')
    })
  })
})
