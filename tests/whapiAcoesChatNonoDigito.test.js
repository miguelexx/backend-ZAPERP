/**
 * Whapi — endereço do chat e o 9º dígito nas DEMAIS ações de chat
 * (archiveChat / unarchiveChat / readChat / patchChat / pinChat / muteChat).
 *
 * Mesmo bug do `deleteChat` (tests/whapiDeleteChatNonoDigito.test.js), medido no canal de
 * produção em 20/10 (MCP, só leitura):
 *   GET /chats/553493120506@s.whatsapp.net  → 200 (o chat real)
 *   GET /chats/5534993120506@s.whatsapp.net → 404 "specified chat not found"
 *
 * O chat BR vive na Whapi quase sempre SEM o 9º dígito; `toWhapiChatId` o INSERE. Com um
 * endereço só, arquivar / marcar lido / fixar / silenciar batiam num chat inexistente, levavam
 * 404 e falhavam em silêncio. Aqui garantimos a tentativa em ordem e que o resultado distingue
 * "aplicou", "não existe em forma nenhuma" e "o provedor recusou".
 */

describe('Whapi — ações de chat tentam as formas do número', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  /** @param {(url:string, method:string)=>{status:number, body?:any}} responder */
  function mockDeps(responder, { semInstancia = false } = {}) {
    const urls = []
    const fetchWithRetry = jest.fn(async (url, opts) => {
      urls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null })
      const r = responder(url, opts?.method)
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => JSON.stringify(r.body ?? {}),
      }
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
      getWhatsappInstanceById: jest.fn(async () => (semInstancia
        ? { instance: null, error: 'not found' }
        : {
          instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true },
          error: null,
        })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { urls }
  }

  const OPTS = { companyId: 1, whatsappInstanceId: 10 }
  const naoEncontrado = { status: 404, body: { error: { code: 404, message: 'specified chat not found' } } }
  const SEM_NONO = '553493120506%40s.whatsapp.net'
  const COM_NONO = '5534993120506%40s.whatsapp.net'
  const soOChatReal = (url) => (url.includes(SEM_NONO) ? { status: 200, body: { success: true } } : naoEncontrado)

  /**
   * As quatro ações endereçadas por chat. `run` recebe o provider já carregado.
   * `metodo` é o verbo HTTP esperado — archive é POST, o resto é PATCH.
   */
  const ACOES = [
    { nome: 'archiveChat', metodo: 'POST', run: (w) => w.archiveChat('5534993120506', OPTS), corpo: { archive: true } },
    { nome: 'unarchiveChat', metodo: 'POST', run: (w) => w.unarchiveChat('5534993120506', OPTS), corpo: { archive: false } },
    { nome: 'readChat', metodo: 'PATCH', run: (w) => w.readChat('5534993120506', OPTS), corpo: { mark_unread: false } },
    { nome: 'patchChat', metodo: 'PATCH', run: (w) => w.patchChat('5534993120506', { pin: true }, OPTS), corpo: { pin: true } },
    { nome: 'pinChat', metodo: 'PATCH', run: (w) => w.pinChat('5534993120506', true, OPTS), corpo: { pin: true } },
    { nome: 'muteChat', metodo: 'PATCH', run: (w) => w.muteChat('5534993120506', false, OPTS), corpo: { mute_until: 0 } },
  ]

  describe.each(ACOES)('$nome', ({ metodo, run, corpo }) => {
    test('conversa gravada COM o 9º: cai no 404 e aplica na forma de 12 dígitos', async () => {
      const { urls } = mockDeps(soOChatReal)
      const r = await run(require('../services/providers/whapi'))

      expect(r.ok).toBe(true)
      expect(r.chatId).toBe('553493120506@s.whatsapp.net')
      // Tentou a forma crua primeiro e só então a variante — nunca o contrário.
      expect(urls).toHaveLength(2)
      expect(urls[0].url).toContain(COM_NONO)
      expect(urls[1].url).toContain(SEM_NONO)
      expect(urls.every((u) => u.method === metodo)).toBe(true)
      // O corpo da requisição não muda por causa da troca de endereço.
      expect(urls[1].body).toEqual(corpo)
    })

    test('nenhuma forma existe → naoExistia (não é "o provedor recusou")', async () => {
      mockDeps(() => naoEncontrado)
      const r = await run(require('../services/providers/whapi'))

      expect(r.ok).toBe(false)
      expect(r.naoExistia).toBe(true)
      expect(r.httpStatus).toBe(404)
    })

    test('erro que NÃO é 404 para na primeira (não insiste em falha real)', async () => {
      const { urls } = mockDeps(() => ({ status: 500, body: { error: { message: 'internal' } } }))
      const r = await run(require('../services/providers/whapi'))

      expect(r.ok).toBe(false)
      expect(r.naoExistia).toBeUndefined()
      expect(r.httpStatus).toBe(500)
      expect(urls).toHaveLength(1)
    })

    test('200 com body de erro não conta como aplicado', async () => {
      mockDeps(() => ({ status: 200, body: { success: false, error: 'nope' } }))
      const r = await run(require('../services/providers/whapi'))
      expect(r.ok).toBe(false)
    })

    test('instância não configurada não chama o provedor', async () => {
      const { urls } = mockDeps(() => ({ status: 200, body: { success: true } }), { semInstancia: true })
      const r = await run(require('../services/providers/whapi'))

      expect(r.ok).toBe(false)
      expect(urls).toHaveLength(0)
    })
  })

  test('número já gravado SEM o 9º aplica de primeira (1 chamada só)', async () => {
    const { urls } = mockDeps(soOChatReal)
    const whapi = require('../services/providers/whapi')

    const r = await whapi.readChat('553493120506', OPTS)

    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0].url).toContain(SEM_NONO)
  })

  test('grupo usa o JID e NÃO gera variantes de telefone', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: { success: true } }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.archiveChat('120363000000000000@g.us', OPTS)

    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0].url).toContain('120363000000000000%40g.us')
  })

  test('LID tem um endereço só (não é telefone, não varia)', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: { success: true } }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.patchChat('lid:280396956696801', { pin: true }, OPTS)

    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0].url).toContain('280396956696801%40lid')
  })

  test('patchChat sem campo válido nem resolve instância nem chama a API', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: { success: true } }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.patchChat('5534993120506', { lixo: 1 }, OPTS)

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/campo/i)
    expect(urls).toHaveLength(0)
  })

  test('clearChatMessages continua 501: a Whapi não tem endpoint de limpar o chat', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: { success: true } }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.clearChatMessages('553493120506', OPTS)

    expect(r.ok).toBe(false)
    expect(r.notImplemented).toBe(true)
    expect(r.httpStatus).toBe(501)
    expect(urls).toHaveLength(0)
  })
})
