/**
 * Fase A — adapter Whapi: sendText (Bearer+JSON), aceite/erro, guarda de provider e tenant.
 * Sem token real, sem número de cliente. fetch mockado. Ver docs/ai-handoff/25.
 */

describe('Whapi provider — sendText', () => {
  let prevWebhookToken
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
    prevWebhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    if (prevWebhookToken === undefined) delete process.env.WHATSAPP_WEBHOOK_TOKEN
    else process.env.WHATSAPP_WEBHOOK_TOKEN = prevWebhookToken
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, defaultByCompany = {}, fetchImpl = null } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.OK' } }),
    })))
    const beforeWhatsAppSend = jest.fn(async () => ({ allow: true }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend,
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: instancesById[`${companyId}:${id}`] || null,
        error: instancesById[`${companyId}:${id}`] ? null : 'not found',
      })),
      getDefaultWhatsappInstance: jest.fn(async (companyId) => ({
        instance: defaultByCompany[companyId] || null,
        error: defaultByCompany[companyId] ? null : 'not found',
      })),
    }))
    return { fetchWithRetry, beforeWhatsAppSend }
  }

  const whapiInstance = (over = {}) => ({
    id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true, ...over,
  })

  test('envia com Bearer + JSON e devolve { ok, messageId }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'olá', { companyId: 1, whatsappInstanceId: 10 })

    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.OK')
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/text')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(opts.body)
    expect(sent.to).toBe('5534988887777')
    expect(sent.body).toBe('olá')
  })

  test('HTTP 401 / sent=false NÃO é sucesso', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'unauthorized' } }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'oi', { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(false)
    expect(r.messageId).toBeNull()
    expect(String(r.error).toLowerCase()).toContain('unauthorized')
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
  })

  test('instância provider=ultramsg é RECUSADA pelo adapter Whapi (não envia)', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance({ provider: 'ultramsg' }) },
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'oi', { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    expect(String(r.error)).toMatch(/não configurada/i)
  })

  test('empresa A não usa instância de empresa B (tenant isolado)', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() }, // só empresa 1 tem a instância 10
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'oi', { companyId: 2, whatsappInstanceId: 10 })
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('sendImage envia Bearer+JSON { to, media, caption } e devolve message.id síncrono', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sent: true, message: { id: 'AbCd-EfGh' } }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendImage('5534988887777', 'https://cdn.example/a.jpg', 'legenda', {
      companyId: 1, whatsappInstanceId: 10, returnDetails: true,
    })
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('AbCd-EfGh')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/image')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', media: 'https://cdn.example/a.jpg', caption: 'legenda' })
  })

  test('sendVoice usa /messages/voice; sendAudio usa /messages/audio', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    await whapi.sendVoice('5534988887777', 'https://cdn.example/a.ogg', { companyId: 1, whatsappInstanceId: 10, returnDetails: true })
    await whapi.sendAudio('5534988887777', 'https://cdn.example/a.mp3', { companyId: 1, whatsappInstanceId: 10, returnDetails: true })
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/messages/voice')
    expect(fetchWithRetry.mock.calls[1][0]).toBe('https://gate.whapi.test/messages/audio')
  })

  test('sendReaction é PUT /messages/{id}/reaction e retorna boolean', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.sendReaction('5534988887777', 'AbCd-EfGh', '👍', { companyId: 1, whatsappInstanceId: 10 })
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('PUT')
    expect(url).toBe('https://gate.whapi.test/messages/AbCd-EfGh/reaction')
    expect(JSON.parse(opts.body)).toEqual({ emoji: '👍' })
  })

  test('getContacts continua stub 501 (Fase D); sendCall também', async () => {
    mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const q = await whapi.getContacts({ companyId: 1 })
    expect(q.notImplemented).toBe(true)
    expect(q.httpStatus).toBe(501)
    const call = await whapi.sendCall()
    expect(call.ok).toBe(false)
    expect(call.notImplemented).toBe(true)
  })

  test('uploadMedia POST /media sem send guard e devolve link', async () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const tmp = path.join(os.tmpdir(), `whapi-up-${Date.now()}.jpg`)
    fs.writeFileSync(tmp, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    try {
      const { fetchWithRetry } = mockDeps({
        instancesById: { '1:10': whapiInstance() },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'media-1', link: 'https://cdn.example/x.jpg' }),
        }),
      })
      const whapi = require('../services/providers/whapi')
      const r = await whapi.uploadMedia(tmp, 'foto.jpg', { companyId: 1, whatsappInstanceId: 10 })
      expect(r.ok).toBe(true)
      expect(r.url).toBe('https://cdn.example/x.jpg')
      expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/media')
      const sent = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
      expect(String(sent.media).startsWith('data:image/jpeg;base64,')).toBe(true)
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  })

  test('GET /health AUTH marca connected e lê user.id', async () => {
    mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: { code: 4, text: 'AUTH' },
          user: { id: '553499911246' },
          channel_id: 'NEBULA-AER3B',
        }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getConnectionStatus({ companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(true)
    expect(r.connected).toBe(true)
    expect(r.status).toBe('AUTH')
    expect(r.phone).toBe('553499911246')
    expect(r.channelId).toBe('NEBULA-AER3B')
  })

  test('configureWebhooks faz PATCH /settings sem token na query e com header X-Webhook-Token', async () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = 'webhook-secret-test'
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.configureWebhooks('https://app.example.com/', { companyId: 1, whatsappInstanceId: 10 })
    expect(r).toEqual([expect.objectContaining({
      label: 'webhook',
      ok: true,
      webhook_url: 'https://app.example.com/webhooks/whapi',
    })])
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/settings')
    expect(opts.method).toBe('PATCH')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    const sent = JSON.parse(opts.body)
    expect(sent.webhooks).toHaveLength(1)
    expect(sent.webhooks[0].url).toBe('https://app.example.com/webhooks/whapi')
    expect(String(sent.webhooks[0].url)).not.toMatch(/[?&]token=/)
    expect(sent.webhooks[0].mode).toBe('body')
    expect(sent.webhooks[0].headers['X-Webhook-Token']).toBe('webhook-secret-test')
    expect(sent.webhooks[0].events).toEqual(expect.arrayContaining([
      { type: 'messages', method: 'post' },
      { type: 'messages', method: 'put' },
      { type: 'statuses', method: 'post' },
      { type: 'statuses', method: 'put' },
    ]))
  })

  test('configureWebhooks recusa sem WHATSAPP_WEBHOOK_TOKEN e não chama a API', async () => {
    delete process.env.WHATSAPP_WEBHOOK_TOKEN
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.configureWebhooks('https://app.example.com', { companyId: 1, whatsappInstanceId: 10 })
    expect(r[0].ok).toBe(false)
    expect(String(r[0].error || '')).toMatch(/WHATSAPP_WEBHOOK_TOKEN/)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})
