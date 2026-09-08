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

  test('deleteMessage é DELETE /messages/{id} e retorna boolean', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }),
    })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.deleteMessage('5534988887777', 'AbCd-EfGh', { companyId: 1, whatsappInstanceId: 10 })
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('DELETE')
    expect(url).toBe('https://gate.whapi.test/messages/AbCd-EfGh')
  })

  test('editMessage POST /messages/text com campo edit', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.editMessage('5534988887777', 'AbCd-EfGh', 'texto novo', {
      companyId: 1, whatsappInstanceId: 10,
    })
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/text')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', body: 'texto novo', edit: 'AbCd-EfGh' })
  })

  test('editMessage com allowEmpty envia body vazio (legenda de mídia)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': whapiInstance() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.editMessage('5534988887777', 'AbCd-EfGh', '', {
      companyId: 1, whatsappInstanceId: 10, allowEmpty: true,
    })
    expect(r.ok).toBe(true)
    expect(JSON.parse(fetchWithRetry.mock.calls[0][1].body)).toEqual({
      to: '5534988887777', body: '', edit: 'AbCd-EfGh',
    })
  })

  test('readChat PATCH /chats/{ChatID} mark_unread false', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }),
    })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.readChat('5534988887777', { companyId: 1, whatsappInstanceId: 10 })
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('PATCH')
    expect(url).toBe('https://gate.whapi.test/chats/5534988887777%40s.whatsapp.net')
    expect(JSON.parse(opts.body)).toEqual({ mark_unread: false })
  })

  test('archiveChat POST /chats/{ChatID} archive true', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }),
    })
    const whapi = require('../services/providers/whapi')
    const ok = await whapi.archiveChat('5534988887777', { companyId: 1, whatsappInstanceId: 10 })
    expect(ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(opts.method).toBe('POST')
    expect(url).toBe('https://gate.whapi.test/chats/5534988887777%40s.whatsapp.net')
    expect(JSON.parse(opts.body)).toEqual({ archive: true })
  })

  test('getContacts GET /contacts devolve { data, hasMore, rawCount }', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          contacts: [{ id: '5534988887777@s.whatsapp.net', name: 'Maria', saved: true }],
        }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const q = await whapi.getContacts(1, 10, { companyId: 1, whatsappInstanceId: 10 })
    expect(q.data).toHaveLength(1)
    expect(q.data[0].name).toBe('Maria')
    expect(fetchWithRetry.mock.calls[0][0]).toContain('/contacts')
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('GET')
  })

  test('getChatMessages GET /messages/list/{ChatID} mapeia from_me e link', async () => {
    mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          messages: [{
            id: 'AbCd-EfGh',
            from_me: false,
            type: 'image',
            timestamp: 1700000000,
            image: { link: 'https://cdn.example/a.jpg', caption: 'foto' },
          }],
        }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const list = await whapi.getChatMessages('5534988887777', 10, null, { companyId: 1, whatsappInstanceId: 10 })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('AbCd-EfGh')
    expect(list[0].fromMe).toBe(false)
    expect(list[0].imageUrl).toBe('https://cdn.example/a.jpg')
  })

  test('sendCall POST /calls/outgoing com duration e call_id', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ call_id: 'call-ABC123', status: 'initiated', duration: 5 }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendCall('5534988887777', 5, { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('call-ABC123')
    const outgoing = fetchWithRetry.mock.calls.filter(([url]) => String(url).includes('/calls/outgoing'))
    expect(outgoing.length).toBeGreaterThanOrEqual(1)
    const [url, opts] = outgoing[0]
    expect(url).toBe('https://gate.whapi.test/calls/outgoing')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', duration: 5 })
    expect(fetchWithRetry.mock.calls.some(([u]) => String(u).includes('/settings'))).toBe(true)
  })

  test('sendCall preserva JID @lid e no 503 liga outgoing_calls_enabled e retenta', async () => {
    let outgoingPosts = 0
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async (url) => {
        if (String(url).includes('/settings')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ outgoing_calls_enabled: true }) }
        }
        outgoingPosts += 1
        if (outgoingPosts === 1) {
          return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Outgoing calls are disabled' }) }
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ call_id: 'call-2', status: 'initiated', duration: 4 }) }
      },
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendCall('123456789012345@lid', 4, { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('call-2')
    const urls = fetchWithRetry.mock.calls.map((c) => c[0])
    expect(urls.filter((u) => String(u).includes('/calls/outgoing'))).toHaveLength(2)
    expect(urls.some((u) => String(u).endsWith('/settings'))).toBe(true)
    const firstOutgoing = fetchWithRetry.mock.calls.find(([u]) => String(u).includes('/calls/outgoing'))
    expect(JSON.parse(firstOutgoing[1].body)).toEqual({
      to: '123456789012345@lid',
      duration: 4,
    })
  })

  test('sendCall tenta JID depois de 400 nos dígitos e aceita call_id sem status initiated', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async (url, opts) => {
        if (String(url).includes('/settings')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ outgoing_calls_enabled: true }) }
        }
        const body = JSON.parse(opts.body || '{}')
        if (body.to === '5534988887777') {
          return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'Invalid to' }) }
        }
        if (body.to === '5534988887777@s.whatsapp.net') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ call_id: 'call-jid-1' }) }
        }
        return { ok: false, status: 500, text: async () => 'unexpected' }
      },
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendCall('5534988887777', 15, { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('call-jid-1')
    const tos = fetchWithRetry.mock.calls
      .filter(([url]) => String(url).includes('/calls/outgoing'))
      .map(([, opts]) => JSON.parse(opts.body).to)
    expect(tos).toEqual(['5534988887777', '5534988887777@s.whatsapp.net'])
  })

  test('sendCall completa o 9º dígito BR antes do número de 12 dígitos', async () => {
    const seen = []
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async (url, opts) => {
        if (String(url).includes('/settings')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ outgoing_calls_enabled: true }) }
        }
        const body = JSON.parse(opts.body || '{}')
        seen.push(body.to)
        if (body.to === '5534984080098') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ call_id: 'call-br9' }) }
        }
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'Invalid to' }) }
      },
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendCall('553484080098', 8, { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('call-br9')
    expect(seen[0]).toBe('5534984080098')
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
    const { fetchWithRetry } = mockDeps({
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
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/health?wakeup=true')
  })

  test('GET /health code 4 sem text ainda marca connected', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': whapiInstance() },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: { code: 4 },
          user: { id: '553499911246' },
        }),
      }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getConnectionStatus({ companyId: 1, whatsappInstanceId: 10, wakeup: false })
    expect(r.connected).toBe(true)
    expect(r.status).toBe('AUTH')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/health')
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
