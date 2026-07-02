const {
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
  extractUltraMsgMessageId,
} = require('../helpers/whatsappMessageIdHelper')
const { _test } = require('../services/pendingOutboundReconciliationService')

describe('whatsappMessageIdHelper', () => {
  test('isRealWhatsAppId aceita hex e ids com @', () => {
    expect(isRealWhatsAppId('BAE543FE1CE17AFA')).toBe(true)
    expect(isRealWhatsAppId('false_5511999999999@c.us_ABC')).toBe(true)
  })

  test('isRealWhatsAppId rejeita id numerico curto de fila', () => {
    expect(isRealWhatsAppId('35096')).toBe(false)
  })

  test('isUltramsgNumericQueueId identifica fila interna', () => {
    expect(isUltramsgNumericQueueId('35096')).toBe(true)
    expect(isUltramsgNumericQueueId('BAE543FE1CE17AFA')).toBe(false)
  })

  test('buildCrmReferenceId', () => {
    expect(buildCrmReferenceId(123)).toBe('crm-123')
    expect(buildCrmReferenceId('abc')).toBeNull()
  })

  test('extractUltraMsgMessageId', () => {
    expect(extractUltraMsgMessageId({ id: 'BAE543FE1CE17AFA', status: 'sent' })).toBe('BAE543FE1CE17AFA')
  })
})

describe('pendingOutboundReconciliationService helpers', () => {
  test('providerRowIndicatesSuccess', () => {
    expect(_test.providerRowIndicatesSuccess({ status: 'sent' })).toBe(true)
    expect(_test.providerRowIndicatesSuccess({ ack: '2' })).toBe(true)
    expect(_test.providerRowIndicatesSuccess({ status: 'queue' })).toBe(false)
  })

  test('providerRowIndicatesFailure', () => {
    expect(_test.providerRowIndicatesFailure({ status: 'unsent' })).toBe(true)
    expect(_test.providerRowIndicatesFailure({ status: 'invalid' })).toBe(true)
    expect(_test.providerRowIndicatesFailure({ status: 'sent' })).toBe(false)
  })

  test('mapProviderAckToStatus', () => {
    expect(_test.mapProviderAckToStatus({ ack: '3' })).toBe('read')
    expect(_test.mapProviderAckToStatus({ status: 'sent' })).toBe('sent')
  })
})
