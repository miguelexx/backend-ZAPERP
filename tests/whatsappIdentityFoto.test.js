/**
 * Identidade WhatsApp para foto de perfil:
 * celular 12↔13 casa; fixo NÃO casa com um celular que só ganhou o 9 após o DDD.
 */

const {
  possiblePhonesBR,
  possiblePhonesForWhatsappIdentity,
  whatsappIdentityKey,
  isSameWhatsappIdentity,
} = require('../helpers/phoneHelper')
const {
  profilePictureChatIdCandidates,
  contactRecordMatchesChatId,
  toLookupChatId,
} = require('../services/providers/ultramsg')

describe('possiblePhonesForWhatsappIdentity — não misturar fixo e celular', () => {
  test('celular com/sem 9º dígito gera as duas variantes', () => {
    const with9 = possiblePhonesForWhatsappIdentity('5534984079198')
    const without9 = possiblePhonesForWhatsappIdentity('553484079198')
    expect(with9).toEqual(expect.arrayContaining(['5534984079198', '553484079198']))
    expect(without9).toEqual(expect.arrayContaining(['5534984079198', '553484079198']))
  })

  test('fixo NÃO inventa o 9 (evita foto de outro contato)', () => {
    const landline = possiblePhonesForWhatsappIdentity('553434123456')
    expect(landline).toEqual(['553434123456'])
    expect(landline).not.toContain('553494123456')
  })

  test('celular 13 dígitos cujo local sem 9 parece fixo NÃO cai no 12 dígitos do fixo', () => {
    // 55+34+9+34123456 = o que possiblePhonesBR inventa a partir do fixo 553434123456
    const mobileOverLandline = possiblePhonesForWhatsappIdentity('5534934123456')
    expect(mobileOverLandline).toEqual(['5534934123456'])
    expect(mobileOverLandline).not.toContain('553434123456')
  })

  test('possiblePhonesBR ainda mistura fixo+9 (não usar para foto)', () => {
    expect(possiblePhonesBR('553434123456')).toContain('5534934123456')
  })
})

describe('whatsappIdentityKey / isSameWhatsappIdentity', () => {
  test('mesmo celular com/sem 9 é a mesma identidade', () => {
    expect(isSameWhatsappIdentity('5534984079198', '553484079198')).toBe(true)
    expect(whatsappIdentityKey('5534984079198')).toBe(whatsappIdentityKey('553484079198'))
  })

  test('fixo e celular 9+mesmo restante NÃO são a mesma identidade', () => {
    expect(isSameWhatsappIdentity('553434123456', '5534934123456')).toBe(false)
    expect(whatsappIdentityKey('553434123456')).not.toBe(whatsappIdentityKey('5534934123456'))
  })

  test('DDDs diferentes não casam', () => {
    expect(isSameWhatsappIdentity('5511987654321', '5521987654321')).toBe(false)
  })
})

describe('profilePictureChatIdCandidates', () => {
  test('JID explícito do webhook é o único candidato (não força 9)', () => {
    expect(profilePictureChatIdCandidates('553484079198', { chatId: '553484079198@c.us' })).toEqual([
      '553484079198@c.us',
    ])
  })

  test('telefone celular tenta 12 e 13, sem toZapiSendFormat cego', () => {
    const ids = profilePictureChatIdCandidates('553484079198')
    expect(ids).toContain('553484079198@c.us')
    expect(ids).toContain('5534984079198@c.us')
  })

  test('fixo só consulta o JID real', () => {
    const ids = profilePictureChatIdCandidates('553434123456')
    expect(ids).toEqual(['553434123456@c.us'])
  })

  test('toLookupChatId não insere o 9', () => {
    expect(toLookupChatId('553484079198')).toBe('553484079198@c.us')
  })
})

describe('contactRecordMatchesChatId', () => {
  test('aceita o mesmo celular com/sem 9', () => {
    expect(
      contactRecordMatchesChatId({ id: '5534984079198@c.us' }, '553484079198@c.us')
    ).toEqual({ hasIdentity: true, matched: true })
  })

  test('rejeita contato de outro número', () => {
    expect(
      contactRecordMatchesChatId({ id: '5511999999999@c.us' }, '553484079198@c.us')
    ).toEqual({ hasIdentity: true, matched: false })
  })

  test('sem id no payload não afirma match', () => {
    expect(contactRecordMatchesChatId({ name: 'Maria' }, '553484079198@c.us')).toEqual({
      hasIdentity: false,
      matched: false,
    })
  })
})
