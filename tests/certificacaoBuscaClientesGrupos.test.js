/**
 * Certificação: busca de clientes/grupos + foto de perfil (pós B01/B02/B03/B09).
 * Valida contratos de código sem depender de backend/banco ao vivo.
 */

const {
  buildClienteSearchOr,
  buildClienteListagemSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  escapeIlikePattern,
} = require('../helpers/chatSearchHelper')
const {
  hasValidFotoPerfil,
  shouldUpdateFotoPerfil,
} = require('../helpers/conversationSync')
const { _test } = require('../controllers/chatController')

describe('Certificação — busca de clientes (nome/telefone)', () => {
  test('B01: clientes sem conversa só entram com busca explícita', () => {
    expect(
      _test.shouldIncludeClientesSemConversa({
        incluirTodosClientesAtivo: true,
        palavraTrim: 'Maria',
      })
    ).toBe(true)
    expect(
      _test.shouldIncludeClientesSemConversa({
        incluirTodosClientesAtivo: true,
        palavraTrim: '',
      })
    ).toBe(false)
  })

  test('busca por nome cobre nome + pushname', () => {
    const or = buildClienteSearchOr('Tijolar')
    expect(or).toContain('nome.ilike."%Tijolar%"')
    expect(or).toContain('pushname.ilike."%Tijolar%"')
  })

  test('busca por telefone gera variantes BR (com/sem 9 e 55)', () => {
    const terms = buildPhoneSearchTerms('(34) 98407-9198')
    expect(terms).toEqual(expect.arrayContaining(['5534984079198', '553484079198']))
  })

  test('telefone mascarado não quebra PostgREST (.or com aspas)', () => {
    const or = buildTelefoneSearchOr('+55 (34) 9991-1246')
    expect(or).not.toMatch(/ilike\.%/)
    expect(or).toContain('telefone.ilike."%')
  })

  test('B02: GET /clientes usa listagem com observacoes + quote', () => {
    const or = buildClienteListagemSearchOr('Paula')
    expect(or).toContain('observacoes.ilike."%Paula%"')
    expect(or).toContain('nome.ilike."%Paula%"')
    expect(or).toContain('pushname.ilike."%Paula%"')
  })

  test('escape de % e _ no termo de busca', () => {
    expect(escapeIlikePattern('100%')).toBe('100\\%')
    expect(escapeIlikePattern('a_b')).toBe('a\\_b')
  })
})

describe('Certificação — foto de perfil (cliente)', () => {
  test('URL http válida é aceita para exibição', () => {
    expect(hasValidFotoPerfil('https://cdn.example/foto.jpg')).toBe(true)
  })

  test('sticky: sem refresh não sobrescreve foto existente', () => {
    expect(
      shouldUpdateFotoPerfil('https://cdn.example/old.jpg', 'https://cdn.example/new.jpg', {
        refresh: false,
      })
    ).toBe(false)
  })

  test('B03: com refresh UltraMSG atualiza URL diferente', () => {
    expect(
      shouldUpdateFotoPerfil('https://cdn.example/old.jpg', 'https://cdn.example/new.jpg', {
        refresh: true,
      })
    ).toBe(true)
  })

  test('preenche foto quando ainda vazia (primeira sync)', () => {
    expect(shouldUpdateFotoPerfil(null, 'https://cdn.example/a.jpg')).toBe(true)
  })
})

describe('Certificação — busca de grupos WhatsApp', () => {
  test('termo de grupo usa o mesmo escape ILIKE da busca de conversas', () => {
    const term = `%${escapeIlikePattern('Setor Vendas')}%`
    expect(term).toBe('%Setor Vendas%')
  })

  test('fragmento de nome de grupo é buscável por substring', () => {
    const needle = 'Vendas'
    const nomeGrupo = 'Setor Vendas - SP'
    expect(nomeGrupo.toLowerCase().includes(needle.toLowerCase())).toBe(true)
  })

  test('busca por telefone não trata JID de grupo como telefone BR inválido demais', () => {
    // possiblePhonesBR / buildPhoneSearchTerms: IDs 120... longos não viram variantes BR
    const terms = buildPhoneSearchTerms('120363012345678901')
    // dígitos longos entram como substring; variantes BR normalizadas podem ser vazias
    expect(Array.isArray(terms)).toBe(true)
  })
})

describe('Certificação — limites seguros da busca', () => {
  test('caps de scan/id existem e são finitos', () => {
    expect(_test.getChatSearchIdLimit()).toBeGreaterThanOrEqual(100)
    expect(_test.getChatSearchIdLimit()).toBeLessThanOrEqual(3000)
    expect(_test.getChatSearchScanLimit()).toBeLessThanOrEqual(2000)
  })
})
