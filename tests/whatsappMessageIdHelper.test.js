const {
  isRealWhatsAppId,
  isUltramsgNumericQueueId,
  parseCrmReferenceMensagemId,
  isReconcilablePendingWhatsappId,
  buildCrmReferenceId,
} = require('../helpers/whatsappMessageIdHelper')

describe('whatsappMessageIdHelper', () => {
  test('isRealWhatsAppId distingue id WhatsApp de fila numérica', () => {
    expect(isRealWhatsAppId('false_5511999999999@c.us_ABC123')).toBe(true)
    expect(isRealWhatsAppId('35096')).toBe(false)
    expect(isUltramsgNumericQueueId('35096')).toBe(true)
  })

  test('parseCrmReferenceMensagemId extrai id da mensagem CRM', () => {
    expect(parseCrmReferenceMensagemId('crm-12345')).toBe(12345)
    expect(parseCrmReferenceMensagemId('CRM-99')).toBe(99)
    expect(parseCrmReferenceMensagemId('')).toBe(null)
    expect(parseCrmReferenceMensagemId('ref-1')).toBe(null)
  })

  test('buildCrmReferenceId e parse são inversos', () => {
    expect(parseCrmReferenceMensagemId(buildCrmReferenceId(42))).toBe(42)
  })

  test('isReconcilablePendingWhatsappId aceita null e fila numérica', () => {
    expect(isReconcilablePendingWhatsappId(null)).toBe(true)
    expect(isReconcilablePendingWhatsappId('35096')).toBe(true)
    expect(isReconcilablePendingWhatsappId('false_5511@c.us_X')).toBe(false)
  })
})
