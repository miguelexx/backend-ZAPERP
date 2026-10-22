/**
 * Whapi `deleteChat` — apagar a conversa do contato INTEIRA e conferir.
 *
 * Medido no canal de produção em 21/10, no mesmo contato:
 *   5534999911246@s.whatsapp.net (com o 9º) e 553499911246@s.whatsapp.net (sem o 9º)
 * existiam como chats SEPARADOS. Apagando só o primeiro endereço que responde, o gêmeo fica na
 * lista — era o relato "apagou no ZapERP, mas no WhatsApp ficou o card e a última mensagem".
 *
 * Aqui o mock simula ENDEREÇOS (quais existem, e se o DELETE realmente os remove), não contagem
 * de chamadas: é o que reproduz o bug de verdade.
 */

describe('Whapi deleteChat — todos os endereços + conferência', () => {
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

  const COM9 = '5534999911246@s.whatsapp.net'
  const SEM9 = '553499911246@s.whatsapp.net'
  const TEL = '5534999911246'
  const OPTS = { companyId: 1, whatsappInstanceId: 10 }

  /**
   * @param {object} cfg
   * @param {string[]} cfg.existem endereços que existem no canal
   * @param {boolean} [cfg.deleteRemove=true] o DELETE realmente tira da lista?
   * @param {boolean} [cfg.getIndeterminado=false] a conferência falha (nem 200 nem 404)
   * @param {number} [cfg.deleteStatus=200]
   */
  function mockDeps({ existem = [], deleteRemove = true, getIndeterminado = false, deleteStatus = 200 } = {}) {
    const vivos = new Set(existem)
    const chamadas = []
    const idDaUrl = (url) => decodeURIComponent(String(url).split('/chats/')[1] || '')
    const fetchWithRetry = jest.fn(async (url, opts) => {
      const method = opts?.method || 'GET'
      const chatId = idDaUrl(url)
      chamadas.push({ method, chatId, url })
      if (method === 'GET') {
        if (getIndeterminado) return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'unavailable' } }) }
        return vivos.has(chatId)
          ? { ok: true, status: 200, text: async () => JSON.stringify({ id: chatId, type: 'contact' }) }
          : { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'specified chat not found' } }) }
      }
      if (method === 'DELETE') {
        if (deleteStatus >= 300) return { ok: false, status: deleteStatus, text: async () => JSON.stringify({ error: { message: 'internal' } }) }
        if (!vivos.has(chatId)) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'specified chat not found' } }) }
        if (deleteRemove) vivos.delete(chatId)
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
    return { chamadas, vivos }
  }

  const deletes = (chamadas) => chamadas.filter((c) => c.method === 'DELETE').map((c) => c.chatId)

  test('contato com DOIS chats (±9º): apaga os dois, não só o primeiro', async () => {
    const { chamadas, vivos } = mockDeps({ existem: [COM9, SEM9] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.apagados.sort()).toEqual([SEM9, COM9].sort())
    expect(deletes(chamadas)).toEqual(expect.arrayContaining([COM9, SEM9]))
    expect(vivos.size).toBe(0)
    expect(r.verificado).toBe(true)
    expect(r.residuo).toBeUndefined()
  })

  test('só o endereço sem o 9º existe: apaga ele e o 404 do outro não atrapalha', async () => {
    const { chamadas, vivos } = mockDeps({ existem: [SEM9] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.apagados).toEqual([SEM9])
    expect(deletes(chamadas)).toEqual(expect.arrayContaining([COM9, SEM9]))
    expect(vivos.size).toBe(0)
  })

  test('nenhum endereço existe → naoExistia, sem conferência nem arquivamento', async () => {
    const { chamadas } = mockDeps({ existem: [] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(false)
    expect(r.naoExistia).toBe(true)
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(0)
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  test('chat teimoso (200 mas continua na lista): insiste e arquiva, admitindo o resíduo', async () => {
    const { chamadas } = mockDeps({ existem: [SEM9], deleteRemove: false })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.residuo).toBe(true)
    expect(r.arquivado).toBe(true)
    expect(deletes(chamadas).filter((id) => id === SEM9).length).toBeGreaterThanOrEqual(2)
    expect(chamadas.some((c) => c.method === 'POST')).toBe(true)
  })

  test('NUNCA revoga a mensagem residual (não mexe no aparelho do cliente)', async () => {
    const { chamadas } = mockDeps({ existem: [SEM9], deleteRemove: false })
    const whapi = require('../services/providers/whapi')

    await whapi.deleteChat(TEL, OPTS)

    expect(chamadas.some((c) => String(c.url).includes('/messages/'))).toBe(false)
  })

  test('arquivamento desligado: admite o resíduo sem arquivar', async () => {
    process.env.WHAPI_CHAT_DELETE_ARCHIVE_FALLBACK = 'false'
    const { chamadas } = mockDeps({ existem: [SEM9], deleteRemove: false })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.residuo).toBe(true)
    expect(r.arquivado).toBe(false)
    expect(chamadas.some((c) => c.method === 'POST')).toBe(false)
  })

  test('conferência desligada: apaga os endereços e não consulta nada', async () => {
    process.env.WHAPI_CHAT_DELETE_VERIFY = 'false'
    const { chamadas } = mockDeps({ existem: [COM9, SEM9], deleteRemove: false })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.verificado).toBeUndefined()
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  test('erro real no DELETE para na hora e não vira conferência/arquivamento', async () => {
    const { chamadas } = mockDeps({ existem: [COM9, SEM9], deleteStatus: 500 })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(500)
    expect(deletes(chamadas)).toHaveLength(1)
    expect(chamadas.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  test('conferência indeterminada não inventa resíduo nem carimba verificado', async () => {
    mockDeps({ existem: [SEM9], getIndeterminado: true })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(TEL, OPTS)

    expect(r.ok).toBe(true)
    expect(r.residuo).toBeUndefined()
    expect(r.verificado).toBe(false)
  })

  test('grupo tem endereço único: não gera variante nem apaga vizinho', async () => {
    const GRUPO = '120363000000000000@g.us'
    const { chamadas } = mockDeps({ existem: [GRUPO] })
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat(GRUPO, OPTS)

    expect(r.ok).toBe(true)
    expect(deletes(chamadas)).toEqual([GRUPO])
  })
})
