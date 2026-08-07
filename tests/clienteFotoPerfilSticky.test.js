/**
 * Evita foto de perfil de um cliente em outro:
 * - match de telefone sem colisão por últimos 8/10 do E.164
 * - foto_perfil sticky no merge (com refresh explícito)
 */

const {
  phonesMatchDigitally,
  hasValidFotoPerfil,
  shouldUpdateFotoPerfil,
} = require('../helpers/conversationSync')

describe('phonesMatchDigitally — sem colisão entre clientes', () => {
  test('mesmo número com/sem 9º dígito casa', () => {
    expect(phonesMatchDigitally('5534984079198', '553484079198')).toBe(true)
    expect(phonesMatchDigitally('5511999887766', '551199887766')).toBe(true)
  })

  test('mesmo número com/sem DDI 55 casa', () => {
    expect(phonesMatchDigitally('5534984079198', '34984079198')).toBe(true)
  })

  test('mesmos últimos 8 em DDDs diferentes NÃO casam', () => {
    expect(phonesMatchDigitally('5511987654321', '5521987654321')).toBe(false)
    expect(phonesMatchDigitally('5534987654321', '5511987654321')).toBe(false)
  })

  test('últimos 10 do E.164 iguais com DDD diferente NÃO casam', () => {
    expect('5511987654321'.slice(-10)).toBe('5521987654321'.slice(-10))
    expect(phonesMatchDigitally('5511987654321', '5521987654321')).toBe(false)
  })
})

describe('hasValidFotoPerfil — sticky', () => {
  test('aceita http(s)', () => {
    expect(hasValidFotoPerfil('https://cdn.example/a.jpg')).toBe(true)
  })

  test('rejeita vazio/null/não-http', () => {
    expect(hasValidFotoPerfil(null)).toBe(false)
    expect(hasValidFotoPerfil('')).toBe(false)
    expect(hasValidFotoPerfil('null')).toBe(false)
  })
})

describe('shouldUpdateFotoPerfil — sticky + refresh', () => {
  test('preenche quando existente vazia', () => {
    expect(shouldUpdateFotoPerfil(null, 'https://cdn.example/a.jpg')).toBe(true)
    expect(shouldUpdateFotoPerfil('', 'https://cdn.example/a.jpg')).toBe(true)
  })

  test('sem refresh não troca foto já válida', () => {
    expect(
      shouldUpdateFotoPerfil('https://cdn.example/old.jpg', 'https://cdn.example/new.jpg')
    ).toBe(false)
  })

  test('com refresh troca se URL diferente', () => {
    expect(
      shouldUpdateFotoPerfil('https://cdn.example/old.jpg', 'https://cdn.example/new.jpg', {
        refresh: true,
      })
    ).toBe(true)
  })

  test('com refresh não atualiza se URL igual', () => {
    expect(
      shouldUpdateFotoPerfil('https://cdn.example/a.jpg', 'https://cdn.example/a.jpg', {
        refresh: true,
      })
    ).toBe(false)
  })

  test('nunca aplica URL inválida', () => {
    expect(shouldUpdateFotoPerfil(null, 'null')).toBe(false)
    expect(shouldUpdateFotoPerfil('https://cdn.example/a.jpg', '', { refresh: true })).toBe(false)
  })
})
