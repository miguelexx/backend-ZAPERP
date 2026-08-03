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

describe('escalonamento de mensagem presa na fila UltraMSG', () => {
  test('firstQueueIdCandidate prioriza id do provedor e ignora id nao-fila', () => {
    expect(_test.firstQueueIdCandidate({}, { id: '35096' })).toBe('35096')
    expect(_test.firstQueueIdCandidate({ provider_queue_id: '777' }, { id: 'BAE543FE1CE17AFA' })).toBe('777')
    expect(_test.firstQueueIdCandidate({ whatsapp_id: '4321' }, {})).toBe('4321')
    expect(_test.firstQueueIdCandidate({ whatsapp_id: 'BAE543FE1CE17AFA' }, {})).toBeNull()
    expect(_test.firstQueueIdCandidate({}, {})).toBeNull()
  })

  test('janelas de escalonamento tem ordem coerente: flush antes de desistir', () => {
    expect(_test.getQueueFlushAfterMs()).toBeLessThan(_test.getQueueGiveUpAfterMs())
    expect(_test.getQueueFlushMaxAttempts()).toBeGreaterThanOrEqual(1)
  })

  test('defaults: flush em 10min, desistencia em 2h', () => {
    expect(_test.getQueueFlushAfterMs()).toBe(10 * 60_000)
    expect(_test.getQueueGiveUpAfterMs()).toBe(120 * 60_000)
    expect(_test.getQueueFlushMaxAttempts()).toBe(3)
  })

  test("status 'queue' nao e mais tratado como sucesso nem como falha", () => {
    expect(_test.providerRowInQueue({ status: 'queue' })).toBe(true)
    expect(_test.providerRowIndicatesSuccess({ status: 'queue' })).toBe(false)
    expect(_test.providerRowIndicatesFailure({ status: 'queue' })).toBe(false)
  })

  test('reenvio de texto exige automacao incerta, permissao e no maximo uma tentativa anterior', () => {
    const base = {
      origem: 'automacao',
      direcao: 'out',
      texto: 'Mensagem do bot',
      tipo: 'texto',
      autor_usuario_id: null,
      provider_delivery_state: 'uncertain',
      provider_retryable: true,
      provider_attempt_count: 1,
    }
    expect(_test.isRetryableAutomaticText(base)).toBe(true)
    expect(_test.isRetryableAutomaticText({ ...base, autor_usuario_id: 9 })).toBe(false)
    expect(_test.isRetryableAutomaticText({ ...base, provider_attempt_count: 2 })).toBe(false)
    expect(_test.isRetryableAutomaticText({ ...base, provider_delivery_state: 'queued' })).toBe(false)
  })
})
