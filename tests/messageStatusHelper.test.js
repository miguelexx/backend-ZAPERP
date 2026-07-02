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
})
