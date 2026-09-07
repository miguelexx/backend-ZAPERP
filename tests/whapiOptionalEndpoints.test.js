/**
 * Endpoints opcionais Whapi — forwardMessage, checkPhones, getLoginQr.
 * fetch mockado, sem token real, sem número de cliente. Ver docs/ai-handoff/25.
 * Contratos REST confirmados no OpenAPI Whapi:
 *   forward → POST /messages/{MessageID} { to, force? } → { sent, message.id }
 *   check   → POST /contacts { contacts, force_check? } → { contacts:[{ input, status, wa_id }] }
 *   qr      → GET /users/login/image → PNG (bytes)
 */

describe('Whapi — endpoints opcionais', () => {
  let prevBase
  beforeEach(() => {
    jest.resetModules()
    prevBase = process.env.WHAPI_BASE_URL
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    if (prevBase === undefined) delete process.env.WHAPI_BASE_URL
    else process.env.WHAPI_BASE_URL = prevBase
    jest.resetModules()
  })

  function mockDeps({ fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl)
    const beforeWhatsAppSend = jest.fn(async () => ({ allow: true }))
    const afterWhatsAppSend = jest.fn()
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend,
      afterWhatsAppSend,
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: { id, company_id: companyId, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry, beforeWhatsAppSend, afterWhatsAppSend }
  }

  const jsonRes = (obj, { ok = true, status = 200 } = {}) => ({
    ok, status, text: async () => JSON.stringify(obj),
  })
  const binRes = (buf, { ok = true, status = 200, contentType = 'image/png' } = {}) => ({
    ok, status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  })

  const CTX = { companyId: 1, whatsappInstanceId: 10 }

  test('forwardMessage POST /messages/{id} com { to } e devolve messageId', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => jsonRes({ sent: true, message: { id: 'wamid.FWD' } }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.forwardMessage('5534988887777', 'wamid.ORIG', CTX)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.FWD')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/wamid.ORIG')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777' })
    // encaminhar é envio → passa pelo send guard
    expect(beforeWhatsAppSend).toHaveBeenCalledTimes(1)
  })

  test('forwardMessage com force:true inclui o campo', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ sent: true, message: { id: 'x' } }) })
    const whapi = require('../services/providers/whapi')
    await whapi.forwardMessage('5534988887777', 'wamid.ORIG', { ...CTX, force: true })
    expect(JSON.parse(fetchWithRetry.mock.calls[0][1].body)).toEqual({ to: '5534988887777', force: true })
  })

  test('forwardMessage sem id → erro sem chamar a API', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ sent: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.forwardMessage('5534988887777', '', CTX)
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('checkPhones POST /contacts { contacts } → [{ input, exists, waId }] e NÃO usa send guard', async () => {
    const { fetchWithRetry, beforeWhatsAppSend } = mockDeps({
      fetchImpl: async () => jsonRes({ contacts: [
        { input: '5534988887777', status: 'valid', wa_id: '5534988887777' },
        { input: '5534000000000', status: 'invalid' },
      ] }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.checkPhones(['5534988887777', '(34) 0000-0000'], CTX)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/contacts')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ contacts: ['5534988887777', '3400000000'] })
    expect(r).toEqual([
      { input: '5534988887777', exists: true, waId: '5534988887777', status: 'valid' },
      { input: '5534000000000', exists: false, waId: null, status: 'invalid' },
    ])
    expect(beforeWhatsAppSend).not.toHaveBeenCalled()
  })

  test('checkPhones lista vazia não chama a API', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ contacts: [] }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.checkPhones(['abc', ''], CTX)
    expect(r).toEqual([])
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('checkPhones HTTP erro lança (nunca finge sucesso)', async () => {
    mockDeps({ fetchImpl: async () => jsonRes({ error: 'nope' }, { ok: false, status: 401 }) })
    const whapi = require('../services/providers/whapi')
    await expect(whapi.checkPhones(['5534988887777'], CTX)).rejects.toThrow(/recusou/i)
  })

  test('getLoginQr GET /users/login/image → data URI base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => binRes(png) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getLoginQr(CTX)
    expect(r.ok).toBe(true)
    expect(r.mimeType).toBe('image/png')
    expect(r.image).toBe(`data:image/png;base64,${png.toString('base64')}`)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/users/login/image?wakeup=true')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
  })

  test('getLoginQr canal já conectado (sem imagem) → ok:false', async () => {
    mockDeps({ fetchImpl: async () => binRes(Buffer.alloc(0), { ok: false, status: 409 }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getLoginQr(CTX)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(409)
  })
})
