const { normalizeOldMessage } = require('../services/oldMessagesSyncService')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
} = require('../helpers/chatSearchHelper')

describe('old messages contact sync', () => {
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
    expect(or).toContain('nome.ilike.%Sompo%')
    expect(or).toContain('pushname.ilike.%Sompo%')
    expect(or).toContain('telefone.ilike.%Sompo%')
  })

  test('busca de telefone em conversas usa termo bruto e variacoes numericas', () => {
    const or = buildTelefoneSearchOr('(11) 4082-1000')
    expect(or).toContain('telefone.ilike.%(11) 4082-1000%')
    expect(or).toContain('telefone.ilike.%551140821000%')
    expect(or).toContain('telefone.ilike.%5511940821000%')
  })
})
