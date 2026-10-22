/**
 * Whapi `deleteChat` — conferência depois de apagar (resíduo na lista).
 *
 * Sintoma relatado em produção (21/10): o DELETE devolve 200 e o histórico some do aparelho,
 * mas o CARD da conversa e a ÚLTIMA MENSAGEM continuam na lista. O 200 do provedor sozinho não
 * prova que a conversa saiu — e o sistema respondia "apagado no WhatsApp" com a conversa viva.
 *
 * Aqui travamos a sequência: apaga → confere → insiste → arquiva como último recurso, sem
 * NUNCA revogar a mensagem residual (isso apagaria no aparelho do cliente).
 */

describe('Whapi deleteChat — conferência e resíduo', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
    process.env.WHAPI_CHAT_DELETE_RETRY_DELAY_MS = '0'
    delete process.env.WHAPI_CHAT_DELETE_VERIFY
    delete process.env.WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    delete process.env.WHAPI_CHAT_DELETE_RETRY_DELAY_MS
    delete process.env.WHAPI_CHAT_DELETE_VERIFY
    delete process.env.WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK
    jest.resetModules()
  })

  /**
   * @param {{existeDepoisDe?: number[]}} cfg existeDepoisDe: em quais GETs o chat ainda existe
   * (índice do GET, começando em 0). Fora disso o GET devolve 404.
   */
  function mockDeps({ existeNosGets = [], falharSegundoDelete = false } = {}) {
    const chamadas = []
    let gets = 0
    let deletes = 0
    const fetchWithRetry = jest.fn(async (url, opts) => {
      const method = opts?.method || 'GET'
      chamadas.push({ method, url })
      if (method === 'GET') {
        const existe = existeNosGets.includes(gets)
        gets += 1
        return existe
          ? { ok: true, status: 200, text: async () => JSON.stringify({ id: 'x', type: 'contact' }) }
          : { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'specified chat not found' } }) }
      }
      if (method === 'DELETE') {
        deletes += 1
        if (falharSegundoDelete && deletes === 2) {
          return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'internal' } }) }
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }
    })
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'CH', instance_token: 'T', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { chamadas }
  }

  const OPTS = { companyId: 1, whatsappInstanceId: 10 }
  const TEL = '553493120506'

  test('sumiu de primeira: confere uma vez e pronto', async () => {
    const { chamadas } = mockDeps({ existeNosGets: [] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.verificado).toBe(true)
    expect(r.residuo).toBeUndefined()
    expect(chamadas.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  test('sobrou no 1º: insiste e, sumindo, não arquiva nada', async () => {
    const { chamadas } = mockDeps({ existeNosGets: [0] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.residuo).toBeUndefined()
    expect(chamadas.filter((c) => c.method === 'DELETE')).toHaveLength(2)
    expect(chamadas.some((c) => c.method === 'POST')).toBe(false)
  })

  test('resiste às duas: arquiva como último recurso e ADMITE o resíduo', async () => {
    const { chamadas } = mockDeps({ existeNosGets: [0, 1] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.residuo).toBe(true)
    expect(r.arquivado).toBe(true)
    const archive = chamadas.find((c) => c.method === 'POST')
    expect(archive).toBeTruthy()
    expect(archive.url).toContain('/chats/')
  })

  test('NUNCA revoga a mensagem residual (não mexe no aparelho do cliente)', async () => {
    const { chamadas } = mockDeps({ existeNosGets: [0, 1] })
    const whapi = require('../services/providers/whapi')

    await whapi.deleteChat(TEL, OPTS)

    expect(chamadas.some((c) => c.url.includes('/messages/'))).toBe(false)
  })

  test('arquivamento desligado: admite o resíduo sem arquivar', async () => {
    process.env.WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK = 'false'
    const { chamadas } = mockDeps({ existeNosGets: [0, 1] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.residuo).toBe(true)
    expect(r.arquivado).toBe(false)
    expect(chamadas.some((c) => c.method === 'POST')).toBe(false)
  })

  test('conferência desligada: volta ao comportamento antigo (1 DELETE, nenhum GET)', async () => {
    process.env.WHAPI_CHAT_DELETE_VERIFY = 'false'
    const { chamadas } = mockDeps({ existeNosGets: [0, 1] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.verificado).toBeUndefined()
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  test('DELETE que falha não vira conferência nem arquivamento', async () => {
    const chamadas = []
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry: jest.fn(async (url, opts) => {
        chamadas.push({ method: opts?.method, url })
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'internal' } }) }
      }),
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'CH', instance_token: 'T', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(false)
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(0)
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  test('conferência indeterminada (erro no GET) não inventa resíduo', async () => {
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry: jest.fn(async (_url, opts) => (
        (opts?.method || 'GET') === 'DELETE'
          ? { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }
          : { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'unavailable' } }) }
      )),
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'CH', instance_token: 'T', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.residuo).toBeUndefined()
    expect(r.verificado).toBe(false)
  })
})
