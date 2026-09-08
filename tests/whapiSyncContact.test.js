/**
 * Sync individual de contato: foto Whapi não depende de estar na agenda.
 * fetch/API mockados. Ver docs/ai-handoff/25.
 */

describe('syncUltraMsgContact — foto por provider', () => {
  function mockStack({ providerName = 'whapi', meta = null, pic = 'https://cdn.test/foto.jpg' } = {}) {
    const getContactMetadata = jest.fn(async () => meta)
    const getProfilePicture = jest.fn(async () => pic)
    jest.doMock('../config/supabase', () => ({}))
    jest.doMock('../services/providers', () => ({
      getProvider: ({ provider } = {}) => ({
        provider,
        getContactMetadata,
        getProfilePicture,
      }),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveCompanyWhatsappProvider: jest.fn(async () => providerName),
      resolveConversationProvider: jest.fn(async () => providerName),
    }))
    jest.doMock('../services/whatsappConfigService', () => ({
      getEmpresaWhatsappConfig: jest.fn(async () => ({
        config: { instance_id: 'instance1', instance_token: 'tok' },
        error: null,
      })),
    }))
    const svc = require('../services/ultramsgSyncContact')
    return { svc, getContactMetadata, getProfilePicture }
  }

  beforeEach(() => jest.resetModules())
  afterEach(() => jest.resetModules())

  test('Whapi busca foto mesmo sem metadata da agenda', async () => {
    const { svc, getProfilePicture } = mockStack({ providerName: 'whapi', meta: null })
    const r = await svc.syncUltraMsgContact('553499911246', 30, {
      skipPersistence: true,
      skipCache: true,
      whatsappInstanceId: 10,
    })
    expect(r).not.toBeNull()
    expect(r.foto_perfil).toBe('https://cdn.test/foto.jpg')
    expect(getProfilePicture).toHaveBeenCalled()
  })

  test('UltraMSG sem metadata NÃO chama getProfilePicture', async () => {
    const { svc, getProfilePicture } = mockStack({ providerName: 'ultramsg', meta: null, pic: 'https://cdn.test/nao.jpg' })
    const r = await svc.syncUltraMsgContact('553499911246', 1, { skipPersistence: true, skipCache: true })
    expect(r).not.toBeNull()
    expect(r.foto_perfil).toBeNull()
    expect(getProfilePicture).not.toHaveBeenCalled()
  })
})
