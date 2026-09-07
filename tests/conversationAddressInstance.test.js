/**
 * Resolução de instância WhatsApp por conversa/empresa.
 * Trava: empresa só-Whapi não pode cair no default UltraMSG / empresa_zapi.
 */

const {
  pickInstanceForUnboundConversation,
  pickCompanyWhatsappInstance,
} = require('../services/chat/identity/conversationAddressService')

describe('pickInstanceForUnboundConversation', () => {
  const ultra = { id: 1, provider: 'ultramsg', ativo: true, is_default: false }
  const whapi = { id: 30, provider: 'whapi', ativo: true, is_default: false }

  test('empresa só-Whapi (1 ativa, sem is_default) usa a instância Whapi', () => {
    expect(pickInstanceForUnboundConversation([whapi])).toEqual(whapi)
  })

  test('is_default Whapi vence mesmo com UltraMSG ao lado', () => {
    expect(pickInstanceForUnboundConversation([
      ultra,
      { ...whapi, is_default: true },
    ])).toEqual({ ...whapi, is_default: true })
  })

  test('is_default UltraMSG vence com Whapi ao lado', () => {
    expect(pickInstanceForUnboundConversation([
      { ...ultra, is_default: true },
      whapi,
    ])).toEqual({ ...ultra, is_default: true })
  })

  test('2+ ativas sem default não adivinha (não amarra conversa)', () => {
    expect(pickInstanceForUnboundConversation([ultra, whapi])).toBeNull()
  })

  test('ignora inativa e adota a única ativa', () => {
    expect(pickInstanceForUnboundConversation([
      { id: 9, provider: 'ultramsg', ativo: false, is_default: true },
      whapi,
    ])).toEqual(whapi)
  })
})

describe('pickCompanyWhatsappInstance', () => {
  test('2+ sem default prefere UltraMSG (histórico company-level)', () => {
    const ultra = { id: 1, provider: 'ultramsg', ativo: true }
    const whapi = { id: 30, provider: 'whapi', ativo: true }
    expect(pickCompanyWhatsappInstance([whapi, ultra])).toEqual(ultra)
  })

  test('só Whapi (1 ativa) continua Whapi', () => {
    const whapi = { id: 30, provider: 'whapi', ativo: true }
    expect(pickCompanyWhatsappInstance([whapi])).toEqual(whapi)
  })
})

describe('resolveConversationWhatsappInstance — empresa só-Whapi', () => {
  beforeEach(() => {
    jest.resetModules()
    const chain = {
      update() { return this },
      eq() { return this },
      is() { return Promise.resolve({ error: null }) },
    }
    jest.doMock('../config/supabase', () => ({ from: () => chain }))
  })

  test('conversa sem instance_id NÃO usa getDefaultWhatsappInstance (ultramsg/empresa_zapi)', async () => {
    const getDefaultWhatsappInstance = jest.fn(async () => ({
      instance: { id: 99, provider: 'ultramsg' },
      error: null,
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getDefaultWhatsappInstance,
      getWhatsappInstanceById: jest.fn(),
      listWhatsappInstances: jest.fn(async () => ({
        instances: [{ id: 30, provider: 'whapi', ativo: true, is_default: false }],
        error: null,
      })),
    }))
    const { resolveConversationWhatsappInstance } = require('../services/chat/identity/conversationAddressService')
    const conversa = { id: 1, whatsapp_instance_id: null }
    const id = await resolveConversationWhatsappInstance(7, conversa)
    expect(id).toBe(30)
    expect(conversa.whatsapp_instance_id).toBe(30)
    expect(getDefaultWhatsappInstance).not.toHaveBeenCalled()
  })

  test('conversa já com instance_id não relista instâncias', async () => {
    const listWhatsappInstances = jest.fn()
    jest.doMock('../services/whatsappInstanceService', () => ({
      getDefaultWhatsappInstance: jest.fn(),
      getWhatsappInstanceById: jest.fn(),
      listWhatsappInstances,
    }))
    const { resolveConversationWhatsappInstance } = require('../services/chat/identity/conversationAddressService')
    const id = await resolveConversationWhatsappInstance(7, { id: 1, whatsapp_instance_id: 30 })
    expect(id).toBe(30)
    expect(listWhatsappInstances).not.toHaveBeenCalled()
  })
})
