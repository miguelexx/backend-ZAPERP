/**
 * Whapi — de onde sai o NOME do contato (o nome salvo na agenda do celular conectado).
 *
 * Medido no canal de produção em 21/10 (MCP, só leitura). Para um contato que o atendente tem
 * salvo na agenda, o endpoint de contato responde SEM nome e só o de chat traz o nome:
 *   GET /contacts/553497829258             → {"phonebook":false,"saved":false,"id":"553497829258"}
 *   GET /chats/553497829258@s.whatsapp.net → {"name":"Claudia DB", …, last_message.from_name:"❤"}
 *
 * O webhook de mensagem só traz `from_name`, que é o pushname do CLIENTE ("❤", "Rayssa"). Como
 * `isBadName` recusa pushname desse tipo, a lista de conversas caía no telefone cru e o
 * atendente não achava o cliente pelo nome. Aqui garantimos: o nome vem do chat quando
 * `/contacts` não tem nome, o endereço do chat tolera o 9º dígito, e quem já tem nome bom não
 * gasta chamada nenhuma.
 */

describe('Whapi — nome do contato vem da agenda (GET /chats)', () => {
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
  const SEM_NONO = '553497829258'
  const COM_NONO = '5534997829258'
  const chatSemNono = '/chats/' + SEM_NONO + '%40s.whatsapp.net'
  const chatComNono = '/chats/' + COM_NONO + '%40s.whatsapp.net'
  const naoEncontrado = { status: 404, body: { error: { code: 404, message: 'specified chat not found' } } }
  // A resposta real do canal para um contato salvo na agenda: 200, mas sem nome.
  const contatoSemNome = { status: 200, body: { phonebook: false, saved: false, id: SEM_NONO } }

  function carregar() {
    return require('../services/providers/whapi')
  }

  test('/contacts sem nome → nome sai de GET /chats', async () => {
    const { urls } = mockDeps((url) => {
      if (url.includes('/contacts/')) return contatoSemNome
      if (url.includes(chatSemNono)) {
        return { status: 200, body: { type: 'contact', id: SEM_NONO + '@s.whatsapp.net', name: 'Claudia DB', last_message: { from_name: '❤' } } }
      }
      return naoEncontrado
    })
    const meta = await carregar().getContactMetadata(SEM_NONO, OPTS)
    expect(meta?.name).toBe('Claudia DB')
    expect(urls.some((u) => u.includes('/contacts/' + SEM_NONO))).toBe(true)
    expect(urls.some((u) => u.includes(chatSemNono))).toBe(true)
  })

  test('telefone guardado COM o 9º dígito acha o chat que vive sem ele', async () => {
    const { urls } = mockDeps((url) => {
      if (url.includes('/contacts/')) return contatoSemNome
      if (url.includes(chatSemNono)) {
        return { status: 200, body: { id: SEM_NONO + '@s.whatsapp.net', name: 'DISTRIBUIDORA NEVADA LTDA' } }
      }
      return naoEncontrado
    })
    const meta = await carregar().getContactMetadata(COM_NONO, OPTS)
    expect(meta?.name).toBe('DISTRIBUIDORA NEVADA LTDA')
    // Tenta o endereço cru primeiro (o que a Whapi tem) e só depois a variante do 9º dígito.
    const chats = urls.filter((u) => u.includes('/chats/'))
    expect(chats[0]).toContain(chatComNono)
    expect(chats[1]).toContain(chatSemNono)
  })

  test('nome formatado como telefone em /contacts não conta como nome', async () => {
    const { urls } = mockDeps((url) => {
      if (url.includes('/contacts/')) {
        // Visto no canal: o próprio telefone no campo `name`.
        return { status: 200, body: { name: '+55 34 3423-8595', phonebook: true, saved: true, id: SEM_NONO } }
      }
      if (url.includes(chatSemNono)) return { status: 200, body: { id: SEM_NONO + '@s.whatsapp.net', name: 'Agro Fixo' } }
      return naoEncontrado
    })
    const meta = await carregar().getContactMetadata(SEM_NONO, OPTS)
    expect(meta?.name).toBe('Agro Fixo')
    expect(urls.some((u) => u.includes('/chats/'))).toBe(true)
  })

  test('/contacts com nome bom não consulta /chats', async () => {
    const { urls } = mockDeps((url) => {
      if (url.includes('/contacts/')) {
        return { status: 200, body: { name: 'MINAS QUÍMICA FRUTAL LTDA', phonebook: true, saved: true, id: SEM_NONO } }
      }
      return naoEncontrado
    })
    const meta = await carregar().getContactMetadata(SEM_NONO, OPTS)
    expect(meta?.name).toBe('MINAS QUÍMICA FRUTAL LTDA')
    expect(urls.filter((u) => u.includes('/chats/'))).toHaveLength(0)
  })

  test('skipChatNameFallback não gasta chamada de chat (leque de participantes de grupo)', async () => {
    const { urls } = mockDeps((url) => (url.includes('/contacts/') ? contatoSemNome : naoEncontrado))
    const meta = await carregar().getContactMetadata(SEM_NONO, { ...OPTS, skipChatNameFallback: true })
    expect(meta?.name).toBeNull()
    expect(urls.filter((u) => u.includes('/chats/'))).toHaveLength(0)
  })

  test('chat sem nome em nenhum endereço → segue sem nome (não inventa)', async () => {
    mockDeps((url) => (url.includes('/contacts/') ? contatoSemNome : naoEncontrado))
    const meta = await carregar().getContactMetadata(SEM_NONO, OPTS)
    expect(meta?.name ?? null).toBeNull()
  })

  test('pushname do cliente não vira nome: só o `name` do chat é lido', async () => {
    mockDeps((url) => {
      if (url.includes('/contacts/')) return contatoSemNome
      if (url.includes(chatSemNono)) {
        // Chat existe, mas sem nome salvo — só o pushname do cliente na última mensagem.
        return { status: 200, body: { id: SEM_NONO + '@s.whatsapp.net', last_message: { from_name: 'Rayssa' } } }
      }
      return naoEncontrado
    })
    const meta = await carregar().getContactMetadata(SEM_NONO, OPTS)
    expect(meta?.name ?? null).toBeNull()
  })

  test('getChat lê o chat que vive sem o 9º dígito (antes dava 404)', async () => {
    mockDeps((url) => (url.includes(chatSemNono)
      ? { status: 200, body: { id: SEM_NONO + '@s.whatsapp.net', name: 'Claudia DB' } }
      : naoEncontrado))
    const r = await carregar().getChat(COM_NONO, OPTS)
    expect(r.ok).toBe(true)
    expect(r.chat?.name).toBe('Claudia DB')
  })

  test('getChat sem o chat em nenhum endereço devolve 404 explicado', async () => {
    mockDeps(() => naoEncontrado)
    const r = await carregar().getChat(SEM_NONO, OPTS)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(404)
  })
})

describe('Lista de conversas — o que conta como "sem nome"', () => {
  const { needsEnrichment } = require('../helpers/conversaEnrichment')
  const base = { id: 7, telefone: '553497829258', foto_perfil: 'https://exemplo.test/foto.jpg' }

  test('pushname de emoji conta como sem nome (era o furo)', () => {
    expect(needsEnrichment({ ...base, contato_nome: '❤' })).toBe(true)
  })

  test('telefone no lugar do nome conta como sem nome', () => {
    expect(needsEnrichment({ ...base, contato_nome: '553497829258' })).toBe(true)
  })

  test('placeholder da UI conta como sem nome', () => {
    expect(needsEnrichment({ ...base, contato_nome: 'Sem nome' })).toBe(true)
    expect(needsEnrichment({ ...base, contato_nome: 'Contato' })).toBe(true)
  })

  test('nome de verdade com foto não precisa de enriquecimento', () => {
    expect(needsEnrichment({ ...base, contato_nome: 'Claudia DB' })).toBe(false)
  })
})

describe('Nome exibido na conversa — pushname ruim não ganha do nome da agenda', () => {
  const { pickConversationDisplayName } = require('../helpers/contactEnrichment')

  test('pushname de emoji perde para o nome salvo que está no cache', () => {
    const cliente = { nome: null, pushname: '❤', telefone: '553497829258' }
    expect(pickConversationDisplayName(cliente, 'Claudia DB')).toBe('Claudia DB')
  })

  test('telefone como único nome do cliente perde para o cache', () => {
    const cliente = { nome: null, pushname: null, telefone: '553499934924' }
    expect(pickConversationDisplayName(cliente, 'DISTRIBUIDORA NEVADA LTDA')).toBe('DISTRIBUIDORA NEVADA LTDA')
  })

  test('nome bom do cliente continua ganhando do cache (manual/planilha mandam)', () => {
    const cliente = { nome: 'Cliente Editado À Mão', pushname: '❤', telefone: '553497829258' }
    expect(pickConversationDisplayName(cliente, 'Claudia DB')).toBe('Cliente Editado À Mão')
  })

  test('pushname bom é mantido quando o cache não tem nada', () => {
    const cliente = { nome: null, pushname: 'Rayssa', telefone: '553499934924' }
    expect(pickConversationDisplayName(cliente, null)).toBe('Rayssa')
  })

  test('cache com placeholder da UI não é usado como nome', () => {
    const cliente = { nome: null, pushname: null, telefone: '553499934924' }
    expect(pickConversationDisplayName(cliente, 'Sem nome')).toBe('553499934924')
  })

  test('sem cliente e sem cache devolve null (quem chama faz o fallback)', () => {
    expect(pickConversationDisplayName(null, null)).toBeNull()
  })
})
