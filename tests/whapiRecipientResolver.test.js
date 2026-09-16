const {
  normalizeCanonicalWaId,
  isThirteenDigitBrMobileWaId,
  resolveWhapiSendRecipient,
} = require('../services/whapiRecipientResolverService')

describe('whapiRecipientResolverService', () => {
  test('normaliza wa_id privado para JID Whapi sem mudar os digitos', () => {
    expect(normalizeCanonicalWaId('553496616106@c.us')).toBe('553496616106@s.whatsapp.net')
    expect(normalizeCanonicalWaId('553496616106@s.whatsapp.net')).toBe('553496616106@s.whatsapp.net')
    expect(isThirteenDigitBrMobileWaId('5534996616106@c.us')).toBe(true)
    expect(isThirteenDigitBrMobileWaId('553496616106@c.us')).toBe(false)
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
    expect(checkPhones).toHaveBeenCalledWith(
      expect.arrayContaining(['553496616106', '5534996616106']),
      expect.objectContaining({
        companyId: 26,
        whatsappInstanceId: 27,
        forceCheck: true,
      }),
    )
    expect(checkPhones.mock.calls[0][0][0]).toBe('553496616106')
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

  test('wa_id de 13 digitos da agenda e revalidado no checkPhones antes do envio', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '5534996616106', exists: true, waId: '553496616106@s.whatsapp.net', status: 'valid' },
    ])
    const persistCanonicalWaId = jest.fn().mockResolvedValue(true)
    const cliente = { id: 1130535, telefone: '5534996616106', wa_id: '5534996616106@c.us' }
    const result = await resolveWhapiSendRecipient('5534996616106', {
      companyId: 26,
      conversaId: 34803,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 34803, cliente_id: 1130535 },
        cliente,
      }),
      checkPhones,
      persistCanonicalWaId,
    })

    expect(result).toBe('553496616106')
    expect(checkPhones).toHaveBeenCalled()
    expect(persistCanonicalWaId).toHaveBeenCalledWith(
      26,
      cliente,
      '553496616106@s.whatsapp.net',
      { replaceExisting: true },
    )
  })

  test('contato 12 digitos sem historico (Jefferson) consulta o numero gravado e nao so o 9o inserido', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '553496750002', exists: true, waId: '553496750002@s.whatsapp.net', status: 'valid' },
      { input: '5534996750002', exists: false, waId: null, status: 'invalid' },
    ])
    const persistCanonicalWaId = jest.fn().mockResolvedValue(true)
    const cliente = { id: 88, telefone: '553496750002', wa_id: null }
    const result = await resolveWhapiSendRecipient('553496750002', {
      companyId: 26,
      conversaId: 99,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 99, cliente_id: 88, telefone: '553496750002' },
        cliente,
      }),
      checkPhones,
      persistCanonicalWaId,
    })

    expect(checkPhones).toHaveBeenCalledWith(
      expect.arrayContaining(['553496750002', '5534996750002']),
      expect.objectContaining({ companyId: 26, forceCheck: true }),
    )
    expect(checkPhones.mock.calls[0][0][0]).toBe('553496750002')
    expect(result).toBe('553496750002')
    expect(persistCanonicalWaId).toHaveBeenCalledWith(26, cliente, '553496750002@s.whatsapp.net')
  })

  test('mesmo se o adapter ja inseriu o 9o, ainda consulta o 12 dígitos gravado', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '5534996750002', exists: false, waId: null, status: 'invalid' },
      { input: '553496750002', exists: true, waId: '553496750002@s.whatsapp.net', status: 'valid' },
    ])
    const persistCanonicalWaId = jest.fn().mockResolvedValue(true)
    const cliente = { id: 88, telefone: '553496750002', wa_id: null }
    const result = await resolveWhapiSendRecipient('5534996750002', {
      companyId: 26,
      conversaId: 99,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 99, cliente_id: 88, telefone: '553496750002' },
        cliente,
      }),
      checkPhones,
      persistCanonicalWaId,
    })

    expect(checkPhones.mock.calls[0][0][0]).toBe('553496750002')
    expect(result).toBe('553496750002')
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

  test('contato novo gravado so com 13 dígitos ainda consulta a forma 12', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '5534996750002', exists: false, waId: null, status: 'invalid' },
      { input: '553496750002', exists: true, waId: '553496750002@s.whatsapp.net', status: 'valid' },
    ])
    const persistCanonicalWaId = jest.fn().mockResolvedValue(true)
    const cliente = { id: 88, telefone: '5534996750002', wa_id: null }
    const result = await resolveWhapiSendRecipient('5534996750002', {
      companyId: 26,
      conversaId: 99,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 99, cliente_id: 88, telefone: '5534996750002' },
        cliente,
      }),
      checkPhones,
      persistCanonicalWaId,
    })
    expect(checkPhones.mock.calls[0][0]).toEqual(expect.arrayContaining(['553496750002', '5534996750002']))
    expect(result).toBe('553496750002')
  })

  test('conversa sem cliente_id ainda valida 12 e 13 no checkPhones', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '553496750002', exists: true, waId: '553496750002@s.whatsapp.net', status: 'valid' },
    ])
    const persistCanonicalWaId = jest.fn()
    const result = await resolveWhapiSendRecipient('553496750002', {
      companyId: 26,
      conversaId: 99,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 99, telefone: '553496750002', cliente_id: null },
        cliente: null,
      }),
      checkPhones,
      persistCanonicalWaId,
    })
    expect(checkPhones).toHaveBeenCalled()
    expect(persistCanonicalWaId).not.toHaveBeenCalled()
    expect(result).toBe('553496750002')
  })

  test('quando so o 13 dígitos existe no WhatsApp, envia o 13', async () => {
    const checkPhones = jest.fn().mockResolvedValue([
      { input: '553496750002', exists: false, waId: null, status: 'invalid' },
      { input: '5534996750002', exists: true, waId: '5534996750002@s.whatsapp.net', status: 'valid' },
    ])
    const result = await resolveWhapiSendRecipient('5534996750002', {
      companyId: 26,
      conversaId: 99,
      whatsappInstanceId: 27,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 99, telefone: '5534996750002' },
        cliente: { id: 88, telefone: '5534996750002', wa_id: null },
      }),
      checkPhones,
      persistCanonicalWaId: jest.fn(),
    })
    expect(result).toBe('5534996750002')
  })

  test('timeout do checkPhones com celular 12 dígitos nao cai no 9o inventado', async () => {
    const result = await resolveWhapiSendRecipient('553496750002', {
      companyId: 1,
      conversaId: 2,
      whatsappInstanceId: 3,
    }, {
      loadConversationContact: jest.fn().mockResolvedValue({
        conversa: { id: 2, telefone: '553496750002' },
        cliente: { id: 9, telefone: '5534996750002', wa_id: null },
      }),
      checkPhones: jest.fn().mockRejectedValue(new Error('timeout')),
      persistCanonicalWaId: jest.fn(),
    })
    expect(result).toBe('553496750002')
  })
})
