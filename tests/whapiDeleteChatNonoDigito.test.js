/**
 * Whapi `deleteChat` — endereço do chat e o 9º dígito.
 *
 * Bug medido no canal de produção em 20/10 (MCP, só leitura):
 *   GET /chats/553493120506@s.whatsapp.net  → 200 (o chat real)
 *   GET /chats/5534993120506@s.whatsapp.net → 404 "specified chat not found"
 *
 * O chat BR vive na Whapi quase sempre SEM o 9º dígito; `toWhapiChatId` o INSERE (passa por
 * preferredBrSendDigits). Com um endereço só, o DELETE caía em 404 e apagar a conversa no
 * ZapERP não saía do WhatsApp — em silêncio. Aqui garantimos a tentativa em ordem e que o
 * resultado distingue "apagou", "não existe em forma nenhuma" e "o provedor recusou".
 */

describe('Whapi deleteChat — tentativa por forma do número', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  /** @param {(url:string)=>{status:number, body?:any}} responder */
  function mockDeps(responder) {
    const urls = []
    const fetchWithRetry = jest.fn(async (url, opts) => {
      urls.push({ url, method: opts?.method })
      const r = responder(url)
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
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { urls }
  }

  const OPTS = { companyId: 1, whatsappInstanceId: 10 }
  const naoEncontrado = { status: 404, body: { error: { code: 404, message: 'specified chat not found' } } }

  test('conversa gravada COM o 9º: cai no 404 e apaga na forma de 12 dígitos', async () => {
    const { urls } = mockDeps((url) => (url.includes('553493120506%40s.whatsapp.net') ? { status: 200, body: {} } : naoEncontrado))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat('5534993120506', OPTS)

    expect(r.ok).toBe(true)
    expect(r.chatId).toBe('553493120506@s.whatsapp.net')
    expect(urls.every((u) => u.method === 'DELETE')).toBe(true)
    // Tentou a forma crua primeiro e só então a variante — nunca o contrário.
    expect(urls[0].url).toContain('5534993120506%40s.whatsapp.net')
    expect(urls[1].url).toContain('553493120506%40s.whatsapp.net')
  })

  test('conversa gravada SEM o 9º apaga de primeira (1 chamada só)', async () => {
    const { urls } = mockDeps((url) => (url.includes('553493120506%40s.whatsapp.net') ? { status: 200, body: {} } : naoEncontrado))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat('553493120506', OPTS)

    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0].url).toContain('553493120506%40s.whatsapp.net')
  })

  test('nenhuma forma existe → nao_existia (não é "o provedor recusou")', async () => {
    mockDeps(() => naoEncontrado)
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat('5534993120506', OPTS)

    expect(r.ok).toBe(false)
    expect(r.naoExistia).toBe(true)
  })

  test('erro que NÃO é 404 para na hora (não insiste em falha real)', async () => {
    const { urls } = mockDeps(() => ({ status: 500, body: { error: { message: 'internal' } } }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat('5534993120506', OPTS)

    expect(r.ok).toBe(false)
    expect(r.naoExistia).toBeUndefined()
    expect(r.httpStatus).toBe(500)
    expect(urls).toHaveLength(1)
  })

  test('200 com body de erro não conta como apagado', async () => {
    mockDeps(() => ({ status: 200, body: { success: false, error: 'nope' } }))
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteChat('553493120506', OPTS)
    expect(r.ok).toBe(false)
  })

  test('grupo usa o JID e NÃO gera variantes de telefone', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: {} }))
    const whapi = require('../services/providers/whapi')

    const r = await whapi.deleteChat('120363000000000000@g.us', OPTS)

    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0].url).toContain('120363000000000000%40g.us')
  })

  test('instância não configurada não chama o provedor', async () => {
    const { urls } = mockDeps(() => ({ status: 200, body: {} }))
    jest.resetModules()
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({ instance: null, error: 'not found' })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteChat('553493120506', { companyId: 1, whatsappInstanceId: 10 })
    expect(r.ok).toBe(false)
    expect(urls).toHaveLength(0)
  })
})

describe('chatIdCandidates', () => {
  beforeEach(() => jest.resetModules())

  test('telefone BR: forma crua primeiro, variante do 9º depois', () => {
    const { chatIdCandidates } = require('../services/providers/whapi/phones')
    expect(chatIdCandidates('553493120506')).toEqual([
      '553493120506@s.whatsapp.net',
      '5534993120506@s.whatsapp.net',
    ])
  })

  test('JID explícito é respeitado como está', () => {
    const { chatIdCandidates } = require('../services/providers/whapi/phones')
    expect(chatIdCandidates('553493120506@s.whatsapp.net')[0]).toBe('553493120506@s.whatsapp.net')
  })

  test('grupo e LID têm um endereço só', () => {
    const { chatIdCandidates } = require('../services/providers/whapi/phones')
    expect(chatIdCandidates('120363000000000000@g.us')).toEqual(['120363000000000000@g.us'])
    expect(chatIdCandidates('lid:280396956696801')).toEqual(['280396956696801@lid'])
  })

  test('respeita o teto de tentativas', () => {
    const { chatIdCandidates } = require('../services/providers/whapi/phones')
    expect(chatIdCandidates('553493120506', 1)).toHaveLength(1)
  })
})
