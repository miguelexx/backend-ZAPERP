const {
  normalizeOldMessage,
  isUsableHistoryIdentifier,
  resolveChatIdsForConversation,
} = require('../services/oldMessagesSyncService')
const { pickRealPhoneCandidate, isLidPhoneKey } = require('../helpers/phoneHelper')
const {
  classifyChatMessagesPage,
  chatMessageCandidatesForLookup,
} = require('../services/providers/ultramsg')
const {
  buildClienteSearchOr,
  buildClienteListagemSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
} = require('../helpers/chatSearchHelper')

describe('old messages contact sync', () => {
  test('rejeita LID e chat_lid numerico como identificador de historico UltraMSG', () => {
    expect(isUsableHistoryIdentifier('lid:123456789012345')).toBe(false)
    expect(isUsableHistoryIdentifier('123456789012345@lid')).toBe(false)
    expect(isUsableHistoryIdentifier('22099032859659')).toBe(false)
    expect(isUsableHistoryIdentifier('553499911246')).toBe(true)
    expect(isUsableHistoryIdentifier('553499911246@c.us')).toBe(true)
  })

  test('resolve candidatos de sync-old pelo telefone do cliente mesmo com conversa lid:', async () => {
    const candidates = await resolveChatIdsForConversation(1, {
      id: 10,
      telefone: 'lid:999888777',
      chat_lid: '999888777',
      clientes: { telefone: '3499911246', company_id: 1 },
    })
    expect(candidates.some((c) => String(c).includes('3499911246') || String(c).includes('553499911246'))).toBe(true)
    expect(candidates.every((c) => !String(c).toLowerCase().startsWith('lid:'))).toBe(true)
    expect(candidates).not.toContain('999888777')
  })

  test('pickRealPhoneCandidate ignora LID e aceita telefone BR do cliente', () => {
    expect(isLidPhoneKey('lid:abc')).toBe(true)
    expect(pickRealPhoneCandidate('lid:abc', '3499911246')).toBe('3499911246')
    expect(pickRealPhoneCandidate('lid:abc', null)).toBe(null)
  })

  test('marca item sem texto/midia como placeholder vazio para nao importar preview falso', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'wamid-empty-1',
        fromMe: false,
        timestamp: 1760000000,
        type: 'text',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.texto).toBe('(mensagem)')
    expect(normalized?.emptyPlaceholder).toBe(true)
  })

  test('mantem midia reconhecida mesmo sem legenda', () => {
    const normalized = normalizeOldMessage(
      {
        id: 'wamid-image-1',
        fromMe: false,
        timestamp: 1760000000,
        type: 'image',
        imageUrl: 'https://cdn.example.test/image.jpg',
      },
      { isGroup: false }
    )

    expect(normalized?.insert?.tipo).toBe('imagem')
    expect(normalized?.insert?.texto).toBe('(imagem)')
    expect(normalized?.emptyPlaceholder).toBe(false)
  })
})

describe('UltraMSG /chats/messages — telefone/JID e resposta', () => {
  test('gera candidatos @c.us COM e SEM o nono dígito (JID BR de 12 e 13 dígitos)', () => {
    // Muitos números BR de celular ficam armazenados no WhatsApp/UltraMSG sem o "9".
    // Ambas as variantes precisam ser consultadas, senão o histórico volta vazio.
    const candidates = chatMessageCandidatesForLookup('553499911246')
    expect(candidates).toContain('5534999911246@c.us') // com o 9 (13 dígitos)
    expect(candidates).toContain('553499911246@c.us') // sem o 9 (12 dígitos)
  })

  test('aceita entrada já com o nono dígito e ainda oferece a variante sem 9', () => {
    const candidates = chatMessageCandidatesForLookup('5534999911246')
    expect(candidates).toContain('5534999911246@c.us')
    expect(candidates).toContain('553499911246@c.us')
  })

  test('preserva chatId @c.us explícito e não gera lixo para vazio', () => {
    expect(chatMessageCandidatesForLookup('553499911246@c.us')).toContain('553499911246@c.us')
    expect(chatMessageCandidatesForLookup('')).toEqual([])
  })

  test('array de mensagens é interpretado como sucesso com os dados', () => {
    const r = classifyChatMessagesPage({ ok: true, status: 200, data: [{ id: 'a' }, { id: 'b' }] })
    expect(r.ok).toBe(true)
    expect(r.data).toHaveLength(2)
    expect(r.error).toBeNull()
  })

  test('resposta vazia (200 + array vazio) é sucesso vazio, não erro', () => {
    const r = classifyChatMessagesPage({ ok: true, status: 200, data: [] })
    expect(r.ok).toBe(true)
    expect(r.data).toEqual([])
    expect(r.bodyIsErrorObject).toBe(false)
  })

  test('200 com corpo de erro NÃO vira "vazio" silencioso — surface do erro real', () => {
    // UltraMSG responde HTTP 200 com { error: "..." } em token inválido / instância desconectada.
    const r = classifyChatMessagesPage({ ok: true, status: 200, data: { error: 'Wrong token' } })
    expect(r.ok).toBe(false)
    expect(r.bodyIsErrorObject).toBe(true)
    expect(r.error).toMatch(/wrong token/i)
  })

  test('erro HTTP (ex.: 500) é classificado como falha', () => {
    const r = classifyChatMessagesPage({ ok: false, status: 500, text: 'Internal Server Error' })
    expect(r.ok).toBe(false)
    expect(r.data).toEqual([])
    expect(String(r.error)).toBeTruthy()
  })
})

describe('chat search helpers', () => {
  test('gera variacoes de telefone com e sem nono digito para busca em Todas', () => {
    expect(buildPhoneSearchTerms('11 3731-6767')).toEqual(
      expect.arrayContaining(['551137316767', '5511937316767'])
    )
    expect(buildPhoneSearchTerms('55 11 93731-6767')).toEqual(
      expect.arrayContaining(['5511937316767', '551137316767'])
    )
  })

  test('busca de cliente cobre nome, pushname e telefone', () => {
    const or = buildClienteSearchOr('Sompo')
    expect(or).toContain('nome.ilike."%Sompo%"')
    expect(or).toContain('pushname.ilike."%Sompo%"')
    expect(or).toContain('telefone.ilike."%Sompo%"')
  })

  test('listagem GET /clientes inclui observacoes e variantes BR com quote PostgREST', () => {
    const or = buildClienteListagemSearchOr('+55 (34) 9991-1246')
    expect(or).toContain('observacoes.ilike.')
    expect(or).toContain('nome.ilike.')
    expect(or).toContain('pushname.ilike.')
    expect(or).toContain('telefone.ilike."%553499911246%"')
    expect(or).toContain('telefone.ilike."%3499911246%"')
    expect(or).toEqual(expect.stringMatching(/telefone\.ilike\."%55\d{10,11}%"/))
    expect(or).not.toMatch(/ilike\.%/)
  })

  test('busca de telefone em conversas usa termo bruto e variacoes numericas', () => {
    const or = buildTelefoneSearchOr('(11) 4082-1000')
    expect(or).toContain('telefone.ilike."%(11) 4082-1000%"')
    expect(or).toContain('telefone.ilike."%551140821000%"')
    expect(or).toContain('telefone.ilike."%5511940821000%"')
  })

  test('valor com parenteses (telefone mascarado) vai entre aspas duplas para nao quebrar o parser do .or() do PostgREST', () => {
    const or = buildTelefoneSearchOr('+55 (34) 9991-1246')
    // Sem aspas, "(" e ")" são caracteres de controle do .or() e quebram a expressão inteira.
    expect(or).not.toMatch(/ilike\.%/) // nenhuma condição sem aspas
    expect(or).toContain('telefone.ilike."%553499911246%"')
  })

  test('ignora fragmentos numericos curtos misturados em texto livre (evita falso positivo de telefone)', () => {
    // 'zzznonexistent999' so tem 3 digitos ('999') — curto demais para ser telefone,
    // mas casava com qualquer numero que contivesse "999" em qualquer posicao.
    expect(buildPhoneSearchTerms('zzznonexistent999')).toEqual([])
  })

  test('mantem busca por fragmento real de telefone com 4+ digitos', () => {
    expect(buildPhoneSearchTerms('1246')).toEqual(['1246'])
    expect(buildPhoneSearchTerms('9911246')).toEqual(expect.arrayContaining(['9911246']))
  })

  test('buildPhoneSearchTerms retorna array vazio para texto sem digitos suficientes', () => {
    expect(buildPhoneSearchTerms('')).toEqual([])
    expect(buildPhoneSearchTerms('abc')).toEqual([])
    expect(buildPhoneSearchTerms('12')).toEqual([]) // abaixo do MIN_PHONE_SEARCH_DIGITS
  })

  test('buildPhoneSearchTerms nao duplica variacoes', () => {
    const terms = buildPhoneSearchTerms('5511937316767')
    expect(new Set(terms).size).toBe(terms.length)
  })

  test('helpers de limite de busca retornam valores dentro dos bounds', () => {
    const pageSize = getSearchMessagesPageSize()
    expect(pageSize).toBeGreaterThanOrEqual(100)
    expect(pageSize).toBeLessThanOrEqual(5000)

    const scanLimit = getChatSearchScanLimit()
    expect(scanLimit).toBeGreaterThanOrEqual(100)
    expect(scanLimit).toBeLessThanOrEqual(2000)

    const idLimit = getChatSearchIdLimit()
    expect(idLimit).toBeGreaterThanOrEqual(100)
    expect(idLimit).toBeLessThanOrEqual(3000)
  })

  test('escapeIlikePattern escapa % e _ para nao quebrar o padrao ILIKE', () => {
    const { escapeIlikePattern } = require('../helpers/chatSearchHelper')
    expect(escapeIlikePattern('50% off')).toBe('50\\% off')
    expect(escapeIlikePattern('user_name')).toBe('user\\_name')
    expect(escapeIlikePattern('normal')).toBe('normal')
  })
})
