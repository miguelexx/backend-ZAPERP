const {
  normalizeNameSearchKey,
  nameMatchesWordPrefix,
  chatIdentityMatchesSearch,
} = require('../helpers/chatSearchHelper')

describe('busca de clientes por prefixo de palavra', () => {
  test('normaliza acentos e pontuação como separadores', () => {
    expect(normalizeNameSearchKey('  José—Humberto / Filial  ')).toBe('jose humberto filial')
  })

  test.each([
    ['Humberto', 'hu'],
    ['Carlos Humberto', 'hu'],
    ['Pizza hunger', 'hu'],
    ['Shuarts/Marcela', 'mar'],
    ['José Humberto', 'jose hum'],
  ])('aceita %s por %s no início do nome ou palavra', (name, term) => {
    expect(nameMatchesWordPrefix(name, term)).toBe(true)
  })

  test.each([
    ["Shuart's", 'hu'],
    ['Jaó Churrascaria Sirley', 'hu'],
    ['LUCIO BICHUETTI', 'hu'],
    ['Samuel', 'mu'],
  ])('rejeita %s por %s quando o termo está no meio da palavra', (name, term) => {
    expect(nameMatchesWordPrefix(name, term)).toBe(false)
  })

  test('mantém busca numérica por trecho de telefone', () => {
    expect(chatIdentityMatchesSearch({ contato_nome: 'Outro nome', telefone: '+55 34 99991-1246' }, '11246')).toBe(true)
  })

  test('aceita nome vinculado e encontrado_por no filtro defensivo', () => {
    const row = {
      contato_nome: 'Arthur Miguel de Oliveira',
      encontrado_por: 'Isabela Maria de Oliveira',
      nomes_vinculados: [{ nome: 'Isabela Maria de Oliveira', serie: '1ª Série' }],
    }
    expect(chatIdentityMatchesSearch(row, 'Isabela')).toBe(true)
    expect(chatIdentityMatchesSearch(row, 'isabela maria')).toBe(true)
    expect(chatIdentityMatchesSearch(row, 'ISA')).toBe(true)
    expect(chatIdentityMatchesSearch({ contato_nome: 'Arthur Miguel de Oliveira' }, 'Isabela')).toBe(false)
  })
})
