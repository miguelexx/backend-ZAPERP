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

  function mockProviderDeps(instances, fetchImpl = null) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'msg-1', sent: true }),
    })))

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

  test('sendText preserva telefone BR de 12 digitos antes da variante com nono digito', async () => {
    const deps = mockProviderDeps({
      defaultByCompany: {
        10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
      },
      byId: {},
    })

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendText('553434251162', 'Ola', {
      companyId: 10,
      referenceId: 'crm-168719',
    })

    const body = new URLSearchParams(deps.fetchWithRetry.mock.calls[0][1].body)
    expect(result.ok).toBe(true)
    expect(body.get('to')).toBe('+553434251162')
    expect(body.get('referenceId')).toBe('crm-168719')
  })

  test('mantem instance_id prefixado salvo no banco sem duplicar prefixo no envio', async () => {
    const deps = mockProviderDeps({
      defaultByCompany: {
        1: { id: 8, company_id: 1, provider: 'ultramsg', instance_id: 'instance173587', instance_token: 'default-token', ativo: true },
      },
      byId: {},
    })

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendText('34999999999', 'Ola', { companyId: 1 })

    expect(result.ok).toBe(true)
    expect(deps.fetchWithRetry.mock.calls[0][0]).toContain('/instance173587/messages/chat')
    expect(deps.fetchWithRetry.mock.calls[0][0]).not.toContain('/instanceinstance173587/')
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

  test('sendAudio rejeita HTTP 200 sem aceite explicito do provedor', async () => {
    mockProviderDeps({
      defaultByCompany: {
        10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
      },
      byId: {},
    }, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: 'queued internally' }),
    }))

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendAudio('34999999999', 'https://cdn.example.com/audio.mp3', {
      companyId: 10,
      returnDetails: true,
    })

    expect(result.ok).toBe(false)
    expect(result.messageId).toBeNull()
  })

  test('sendVoice rejeita HTTP 200 sem aceite explicito quando fallback esta desabilitado', async () => {
    mockProviderDeps({
      defaultByCompany: {
        10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
      },
      byId: {},
    }, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: 'queued internally' }),
    }))

    const provider = require('../services/providers/ultramsg')
    const result = await provider.sendVoice('34999999999', 'https://cdn.example.com/audio.ogg', {
      companyId: 10,
      returnDetails: true,
      disableAudioFallback: true,
    })

    expect(result.ok).toBe(false)
    expect(result.messageId).toBeNull()
  })
})
