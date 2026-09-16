const {
  normalizeCanonicalWaId,
  resolveWhapiSendRecipient,
} = require('../services/whapiRecipientResolverService')

describe('whapiRecipientResolverService', () => {
  test('normaliza wa_id privado para JID Whapi sem mudar os digitos', () => {
    expect(normalizeCanonicalWaId('553496616106@c.us')).toBe('553496616106@s.whatsapp.net')
    expect(normalizeCanonicalWaId('553496616106@s.whatsapp.net')).toBe('553496616106@s.whatsapp.net')
  })

  test('prefere clientes.wa_id e nao chama checkPhones', async () => {
    const checkPhones = jest.fn()
    const persistCanonicalWaId = jest.fn()
    const result = await resolveWhapiSendRecipient('5534996616106', {
      companyId: 26,
      conversaId: 34803,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 34803, cliente_id: 1130535 },
        cliente: { id: 1130535, telefone: '5534996616106', wa_id: '553496616106@c.us' },
      }),
      checkPhones,
      persistCanonicalWaId,
    })

    expect(result).toBe('553496616106')
    expect(checkPhones).not.toHaveBeenCalled()
    expect(persistCanonicalWaId).not.toHaveBeenCalled()
  })

  test('sem wa_id usa checkPhones, persiste e envia para o wa_id canonico', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '5534996616106', exists: true, waId: '553496616106@s.whatsapp.net', status: 'valid' },
    ])
    const persistCanonicalWaId = jest.fn().mockResolvedValue(true)
    const cliente = { id: 1130535, telefone: '5534996616106', wa_id: null }
    const result = await resolveWhapiSendRecipient('5534996616106', {
      companyId: 26,
      conversaId: 34803,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({ conversa: { id: 34803 }, cliente }),
      checkPhones,
      persistCanonicalWaId,
    })

    expect(result).toBe('553496616106')
    expect(checkPhones).toHaveBeenCalledWith(['5534996616106'], expect.objectContaining({
      companyId: 26,
      whatsappInstanceId: 27,
      forceCheck: true,
    }))
    expect(persistCanonicalWaId).toHaveBeenCalledWith(26, cliente, '553496616106@s.whatsapp.net')
  })

  test('fluxo sem conversa, como disparo, resolve diretamente por cliente_id', async () => {
    const checkPhones = jest.fn()
    const result = await resolveWhapiSendRecipient('5534996616106', {
      companyId: 26,
      clienteId: 1130535,
      whatsappInstanceId: 27,
    }, {
      loadClientById: jest.fn().mockResolvedValue({
        id: 1130535,
        telefone: '5534996616106',
        wa_id: '553496616106@c.us',
      }),
      checkPhones,
    })

    expect(result).toBe('553496616106')
    expect(checkPhones).not.toHaveBeenCalled()
  })

  test('falha na validacao preserva o fallback atual e nao bloqueia o envio', async () => {
    const result = await resolveWhapiSendRecipient('5534988887777', {
      companyId: 1,
      conversaId: 2,
      whatsappInstanceId: 3,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 2 },
        cliente: { id: 9, telefone: '5534988887777', wa_id: null },
      }),
      checkPhones: jest.fn().mockRejectedValue(new Error('timeout')),
      persistCanonicalWaId: jest.fn(),
    })
    expect(result).toBe('5534988887777')
  })
})
