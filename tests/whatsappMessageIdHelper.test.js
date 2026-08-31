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

  test('extractPhoneDigitsFromWhatsappMessageId lê o JID do ACK UltraMSG', () => {
    const { extractPhoneDigitsFromWhatsappMessageId } = require('../helpers/whatsappMessageIdHelper')
    expect(extractPhoneDigitsFromWhatsappMessageId('true_55349841246@c.us_3EB0ABC')).toBe('55349841246')
    expect(extractPhoneDigitsFromWhatsappMessageId('false_5534999741@c.us_SID')).toBe('5534999741')
    expect(extractPhoneDigitsFromWhatsappMessageId('35096')).toBe(null)
    expect(extractPhoneDigitsFromWhatsappMessageId('5534999999999@c.us')).toBe('5534999999999')
  })
})
