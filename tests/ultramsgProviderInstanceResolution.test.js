describe('UltraMsg provider instance resolution', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.ULTRAMSG_SEND_DELAY_MS = '0'
    process.env.ULTRAMSG_BASE_URL = 'https://api.ultramsg.test'
  })

  afterEach(() => {
    delete process.env.ULTRAMSG_SEND_DELAY_MS
    delete process.env.ULTRAMSG_BASE_URL
  })

  function mockProviderDeps(instances) {
    const fetchWithRetry = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'msg-1', sent: true }),
    }))

    jest.doMock('../services/whatsappConfigService', () => ({
      invalidateEmpresaWhatsappConfigCache: jest.fn(),
    }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({ fetchWithRetry }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getDefaultWhatsappInstance: jest.fn(async (companyId) => ({
        instance: instances.defaultByCompany[companyId] || null,
        error: instances.defaultByCompany[companyId] ? null : 'not found',
      })),
      getWhatsappInstanceById: jest.fn(async (companyId, id) => {
        const instance = instances.byId[id]
        if (!instance || instance.company_id !== Number(companyId)) {
          return { instance: null, error: 'Instancia WhatsApp nao encontrada' }
        }
        return { instance, error: null }
      }),
    }))

    return { fetchWithRetry }
  }

  test('usa instancia explicita quando whatsappInstanceId e informado', async () => {
    const deps = mockProviderDeps({
      defaultByCompany: {
        10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
      },
      byId: {
        2: { id: 2, company_id: 10, provider: 'ultramsg', instance_id: '222', instance_token: 'explicit-token', ativo: true },
      },
    })

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendText('34999999999', 'Ola', { companyId: 10, whatsappInstanceId: 2 })

    expect(result.ok).toBe(true)
    expect(deps.fetchWithRetry.mock.calls[0][0]).toContain('/instance222/messages/chat')
    expect(deps.fetchWithRetry.mock.calls[0][1].body).toContain('token=explicit-token')
  })

  test('usa instancia default quando whatsappInstanceId nao e informado', async () => {
    const deps = mockProviderDeps({
      defaultByCompany: {
        10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
      },
      byId: {},
    })

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendText('34999999999', 'Ola', { companyId: 10 })

    expect(result.ok).toBe(true)
    expect(deps.fetchWithRetry.mock.calls[0][0]).toContain('/instance111/messages/chat')
    expect(deps.fetchWithRetry.mock.calls[0][1].body).toContain('token=default-token')
  })

  test('bloqueia instancia de outra empresa', async () => {
    const deps = mockProviderDeps({
      defaultByCompany: {},
      byId: {
        2: { id: 2, company_id: 99, provider: 'ultramsg', instance_id: '222', instance_token: 'secret', ativo: true },
      },
    })

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendText('34999999999', 'Ola', { companyId: 10, whatsappInstanceId: 2 })

    expect(result.ok).toBe(false)
    expect(deps.fetchWithRetry).not.toHaveBeenCalled()
  })
})
