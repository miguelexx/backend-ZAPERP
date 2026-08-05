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
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn((err) => {
        const code = err?.code != null ? String(err.code) : ''
        return ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)
      }),
    }))
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

  describe('referenceId propagado no envio (reconciliacao do eco fromMe)', () => {
    function ambienteEnvio() {
      return mockProviderDeps({
        defaultByCompany: {
          10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
        },
        byId: {},
      })
    }

    function corpoDaChamada(deps, indice = 0) {
      return new URLSearchParams(deps.fetchWithRetry.mock.calls[indice][1].body)
    }

    test('sendText envia referenceId', async () => {
      const deps = ambienteEnvio()
      const provider = require('../services/providers/ultramsg')
      await provider.sendText('34999999999', 'Ola', { companyId: 10, referenceId: 'crm-777' })

      expect(corpoDaChamada(deps).get('referenceId')).toBe('crm-777')
    })

    test('sendImage envia referenceId', async () => {
      const deps = ambienteEnvio()
      const provider = require('../services/providers/ultramsg')
      await provider.sendImage('34999999999', 'https://cdn.example.com/a.jpg', 'legenda', {
        companyId: 10,
        referenceId: 'crm-778',
        returnDetails: true,
      })

      expect(corpoDaChamada(deps).get('referenceId')).toBe('crm-778')
    })

    test('sendFile envia referenceId', async () => {
      const deps = ambienteEnvio()
      const provider = require('../services/providers/ultramsg')
      await provider.sendFile('34999999999', 'https://cdn.example.com/a.pdf', 'nota.pdf', {
        companyId: 10,
        referenceId: 'crm-779',
        returnDetails: true,
      })

      expect(corpoDaChamada(deps).get('referenceId')).toBe('crm-779')
    })

    test('sendAudio envia referenceId', async () => {
      const deps = ambienteEnvio()
      const provider = require('../services/providers/ultramsg')
      await provider.sendAudio('34999999999', 'https://cdn.example.com/a.mp3', {
        companyId: 10,
        referenceId: 'crm-780',
        returnDetails: true,
      })

      expect(corpoDaChamada(deps).get('referenceId')).toBe('crm-780')
    })

    test('sendVoice envia referenceId inclusive no fallback para audio', async () => {
      const deps = mockProviderDeps({
        defaultByCompany: {
          10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'default-token', ativo: true },
        },
        byId: {},
      }, async (url) => ({
        ok: true,
        status: 200,
        // /voice falha para forcar o fallback em /audio; o fallback precisa manter o referenceId.
        text: async () =>
          String(url).includes('/messages/voice')
            ? JSON.stringify({ error: 'voice indisponivel' })
            : JSON.stringify({ id: 'msg-1', sent: true }),
      }))

      const provider = require('../services/providers/ultramsg')
      await provider.sendVoice('34999999999', 'https://cdn.example.com/a.ogg', {
        companyId: 10,
        referenceId: 'crm-781',
        returnDetails: true,
      })

      expect(deps.fetchWithRetry.mock.calls.length).toBeGreaterThan(1)
      expect(corpoDaChamada(deps, 0).get('referenceId')).toBe('crm-781')
      expect(corpoDaChamada(deps, 1).get('referenceId')).toBe('crm-781')
    })

    test('sem referenceId o corpo nao ganha o campo', async () => {
      const deps = ambienteEnvio()
      const provider = require('../services/providers/ultramsg')
      await provider.sendImage('34999999999', 'https://cdn.example.com/a.jpg', '', {
        companyId: 10,
        returnDetails: true,
      })

      expect(corpoDaChamada(deps).has('referenceId')).toBe(false)
    })
  })

  test('uploadMedia retenta em HTTP 5xx e sobe o arquivo na tentativa seguinte', async () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const tmpFile = path.join(os.tmpdir(), `zaperp-upload-retry-${Date.now()}.ogg`)
    fs.writeFileSync(tmpFile, Buffer.from('ogg-fake'))

    let calls = 0
    const deps = mockProviderDeps(
      {
        defaultByCompany: {
          10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'tok', ativo: true },
        },
        byId: {},
      },
      async () => {
        calls += 1
        if (calls === 1) {
          return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'temporary' }) }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ url: 'https://cdn.ultramsg.test/a.ogg' }),
        }
      }
    )

    try {
      const provider = require('../services/providers/ultramsg')
      const result = await provider.uploadMedia(tmpFile, 'a.ogg', {
        companyId: 10,
        maxAttempts: 3,
        baseDelayMs: 0,
      })
      expect(result.ok).toBe(true)
      expect(result.url).toBe('https://cdn.ultramsg.test/a.ogg')
      expect(deps.fetchWithRetry).toHaveBeenCalledTimes(2)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch (_) {}
    }
  })

  test('uploadMedia nao retenta erro semantico no body (4xx util)', async () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const tmpFile = path.join(os.tmpdir(), `zaperp-upload-noretry-${Date.now()}.ogg`)
    fs.writeFileSync(tmpFile, Buffer.from('ogg-fake'))

    const deps = mockProviderDeps(
      {
        defaultByCompany: {
          10: { id: 1, company_id: 10, provider: 'ultramsg', instance_id: '111', instance_token: 'tok', ativo: true },
        },
        byId: {},
      },
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ error: 'wrong token' }),
      })
    )

    try {
      const provider = require('../services/providers/ultramsg')
      const result = await provider.uploadMedia(tmpFile, 'a.ogg', {
        companyId: 10,
        maxAttempts: 3,
        baseDelayMs: 0,
      })
      expect(result.ok).toBe(false)
      expect(String(result.error || '')).toMatch(/wrong token/i)
      expect(deps.fetchWithRetry).toHaveBeenCalledTimes(1)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch (_) {}
    }
  })
})
