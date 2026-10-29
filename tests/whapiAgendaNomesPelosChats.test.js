/**
 * Sincronizar contatos do celular (Whapi) — puxar TODOS, com o nome SALVO NA AGENDA.
 *
 * Medido no canal de produção em 29/10 (só leitura, 1547 itens em GET /contacts): 866 com nome
 * bom, 10 com o telefone formatado no lugar do nome ("+55 34 3423-8595") e 670 SEM nome. Numa
 * amostra de 25 desses sem nome, 7 tinham o nome da agenda em GET /chats/{id} — contatos salvos
 * que a lista reporta como `saved:false`. Antes, eram descartados em silêncio e os 10 nasciam
 * sem nome. Agora: o provider devolve esses ids em `semNome`, e a sincronização completa o nome
 * pela conversa (só para quem tem chat no canal; o endereço tolera o 9º dígito).
 */

describe('Whapi provider — ids sem nome e nomes pelos chats', () => {
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
    const fetchWithRetry = jest.fn(async (url) => {
      urls.push(url)
      const r = responder(url)
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) }
    })
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
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
  const path = (url) => new URL(url).pathname + new URL(url).search
  const chatUrl = (id) => '/chats/' + id + '%40s.whatsapp.net'
  const naoEncontrado = { status: 404, body: { error: { code: 404, message: 'specified chat not found' } } }

  test('getContacts: sem nome e "telefone como nome" vão para semNome; grupo, LID e id "0" ficam fora', async () => {
    // Payload real do canal (29/10), nomes trocados.
    mockDeps(() => ({ status: 200, body: { contacts: [
      { name: 'MARGRE MATERIAIS LTDA', phonebook: true, saved: true, id: '553484142277' },
      { phonebook: false, saved: false, id: '0' },
      { name: '+55 34 3423-8595', phonebook: true, saved: true, id: '553434238595' },
      { phonebook: false, saved: false, id: '554799703083' },
      { pushname: 'Rayssa', phonebook: false, saved: false, id: '553499934924' },
      { name: 'Grupo', id: '120363012345678901@g.us' },
      { id: '123456789012345@lid' },
    ], total: 7, count: 7, offset: 0 } }))
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getContacts(1, 500, OPTS)
    // O telefone formatado continua na lista (vira contato sem nome se o chat não tiver nome)…
    expect(r.data.map((c) => c.name)).toEqual(['MARGRE MATERIAIS LTDA', '+55 34 3423-8595'])
    // …e também é candidato a receber o nome pelo chat. pushname NÃO é nome da agenda.
    expect(r.semNome).toEqual(['553434238595', '554799703083', '553499934924'])
    expect(r.hasMore).toBe(false)
  })

  test('getAgendaNamesFromChats: lê a lista de chats uma vez, só consulta quem tem chat e tolera o 9º dígito', async () => {
    const { urls } = mockDeps((url) => {
      const p = path(url)
      if (p.startsWith('/chats?')) {
        return { status: 200, body: { chats: [
          { id: '553497829258@s.whatsapp.net', type: 'contact' },   // vive SEM o 9
          { id: '5511999990000@s.whatsapp.net', type: 'contact' },
          { id: '120363012345678901@g.us', type: 'group' },
        ], total: 3, count: 3, offset: 0 } }
      }
      if (p === chatUrl('5534997829258')) return naoEncontrado
      if (p === chatUrl('553497829258')) return { status: 200, body: { id: '553497829258@s.whatsapp.net', name: 'Claudia DB', last_message: { from_name: '❤' } } }
      if (p === chatUrl('5511999990000')) return { status: 200, body: { name: '+55 11 99999-0000' } }
      return naoEncontrado
    })
    const whapi = require('../services/providers/whapi')
    const onProgress = jest.fn()
    const r = await whapi.getAgendaNamesFromChats(
      ['5534997829258', '5511999990000', '5522888880000', '5534997829258'], OPTS, { onProgress }
    )
    expect([...r.names]).toEqual([['5534997829258', 'Claudia DB']])
    expect(r).toMatchObject({ total: 3, verificados: 3, encontrados: 1, semChat: 1, chatSemNome: 1, cancelado: false })
    // Lista de chats pedida uma vez; quem não tem chat (5522…) não gasta chamada; o id com o 9
    // caiu no 404 e foi reendereçado sem o 9.
    expect(urls.filter((u) => path(u).startsWith('/chats?'))).toHaveLength(1)
    expect(urls.some((u) => path(u).includes('5522888880000'))).toBe(false)
    expect(urls.some((u) => path(u) === chatUrl('553497829258'))).toBe(true)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ verificados: 3, total: 3, encontrados: 1 }))
  })

  test('getAgendaNamesFromChats: lista de chats indisponível → consulta todos os ids; shouldStop interrompe', async () => {
    const { urls } = mockDeps((url) => {
      const p = path(url)
      if (p.startsWith('/chats?')) return { status: 500, body: { error: { message: 'boom' } } }
      return { status: 200, body: { name: 'Fulano ' + p.slice(-20, -16) } }
    })
    const whapi = require('../services/providers/whapi')
    const ids = Array.from({ length: 9 }, (_, i) => String(5511990000000 + i))
    const r = await whapi.getAgendaNamesFromChats(ids, OPTS)
    expect(r.semChat).toBe(0)
    expect(r.encontrados).toBe(9)
    expect(urls.filter((u) => path(u).startsWith('/chats/'))).toHaveLength(9)

    // A flag de parada é consultada no 1º contato e depois a cada 10 (uma query por consulta).
    let chamadas = 0
    const muitos = Array.from({ length: 24 }, (_, i) => String(5511990000000 + i))
    const parado = await whapi.getAgendaNamesFromChats(muitos, OPTS, { shouldStop: async () => ++chamadas > 1 })
    expect(parado.cancelado).toBe(true)
    expect(parado.verificados).toBeLessThan(24)
    expect(chamadas).toBe(2)
  })
})

describe('Sincronização da agenda — completa nomes pelos chats (Whapi)', () => {
  const { contactSyncDb } = require('./support/contactSyncDb')
  let db, provider, service
  beforeEach(() => {
    jest.resetModules()
    db = contactSyncDb()
    provider = {
      getContacts: jest.fn(),
      getProfilePicture: jest.fn(async () => null),
      getAgendaNamesFromChats: jest.fn(async () => ({ names: new Map(), total: 0, verificados: 0, encontrados: 0, semChat: 0, chatSemNome: 0, cancelado: false })),
    }
    jest.doMock('../config/supabase', () => db)
    jest.doMock('../services/providers', () => ({ getProvider: () => provider }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveContactSyncInstance: async () => ({ provider: 'whapi', whatsappInstanceId: 10 }),
      resolveCompanyWhatsappProvider: async () => 'whapi',
    }))
    jest.doMock('../services/whatsappConfigService', () => ({ getEmpresaWhatsappConfig: async () => ({ config: null, error: 'n/a' }) }))
    jest.doMock('../services/configOperacionalService', () => ({ getConfig: async () => ({}), isProcessamentoPausado: async () => true }))
    jest.doMock('../services/operationalAuditService', () => ({ registrarEvento: jest.fn(), TIPOS: {} }))
    service = require('../services/contactSyncService')
  })
  const agenda = (data, semNome = []) => ({ data, rawCount: data.length + semNome.length, hasMore: false, semNome })

  test('contato sem nome na lista mas com nome no chat é importado; telefone-como-nome ganha o nome da agenda; sem chat não inventa', async () => {
    provider.getContacts.mockResolvedValue(agenda(
      [
        { phone: '553484142277', name: 'MARGRE MATERIAIS LTDA' },
        { phone: '553434238595', name: '+55 34 3423-8595' },
      ],
      ['553434238595', '553497829258', '554799703083']
    ))
    provider.getAgendaNamesFromChats.mockImplementation(async (ids, opts, hooks) => {
      await hooks.onProgress({ verificados: 3, total: 3, encontrados: 2 })
      return {
        names: new Map([['553497829258', 'Claudia DB'], ['553434238595', 'Agro Fixo']]),
        total: 3, verificados: 3, encontrados: 2, semChat: 1, chatSemNome: 0, cancelado: false,
      }
    })
    const onProgress = jest.fn()
    const r = await service.runContactSyncFull(7, { manual: true, jobId: 50, onProgress })
    expect(r).toMatchObject({ ok: true, totalCriados: 3, totalSemNomeNaLista: 3, totalNomesDoChat: 2, totalAgendaValidos: 3 })
    expect(r.aviso).toMatch(/2 contato\(s\) vieram sem nome na lista/)
    expect(provider.getAgendaNamesFromChats).toHaveBeenCalledWith(
      ['553434238595', '553497829258', '554799703083'],
      { companyId: 7, whatsappInstanceId: 10 },
      expect.objectContaining({ onProgress: expect.any(Function) })
    )
    const nomes = db.tables.clientes.filter((c) => c.company_id === 7).map((c) => c.nome).sort()
    expect(nomes).toEqual(['Agro Fixo', 'Claudia DB', 'MARGRE MATERIAIS LTDA'])
    // Quem não tem chat nem nome não nasce no ZapERP (não é contato da agenda).
    expect(db.tables.clientes.some((c) => String(c.telefone).includes('4799703083'))).toBe(false)
    expect(onProgress.mock.calls.some(([p]) => p.fase === 'completando_nomes')).toBe(true)
  })

  test('lista toda com nome → a fase de chats nem é chamada; cancelar durante os chats preserva o que já há', async () => {
    provider.getContacts.mockResolvedValue(agenda([{ phone: '553484142277', name: 'MARGRE' }]))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: true, totalCriados: 1 })
    expect(provider.getAgendaNamesFromChats).not.toHaveBeenCalled()

    provider.getContacts.mockResolvedValue(agenda([{ phone: '553484142277', name: 'MARGRE' }], ['553497829258']))
    provider.getAgendaNamesFromChats.mockResolvedValue({ names: new Map(), total: 1, verificados: 0, encontrados: 0, semChat: 0, chatSemNome: 0, cancelado: true })
    const r = await service.runContactSyncFull(7, { manual: true, shouldCancel: async () => false })
    expect(r).toMatchObject({ ok: true, cancelled: true, totalCriados: 0 })
    expect(db.tables.sync_locks).toHaveLength(0)
  })

  test('provider sem getAgendaNamesFromChats (UltraMSG) ignora semNome e segue como antes', async () => {
    delete provider.getAgendaNamesFromChats
    provider.getContacts.mockResolvedValue(agenda([{ phone: '553484142277', name: 'MARGRE' }], ['553497829258']))
    const r = await service.runContactSyncFull(7, { manual: true })
    expect(r).toMatchObject({ ok: true, totalCriados: 1, totalSemNomeNaLista: 0, totalNomesDoChat: 0 })
  })
})
