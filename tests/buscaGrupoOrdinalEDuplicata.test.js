/**
 * "Não acho o grupo quando pesquiso" — 10/11/2026.
 *
 * Dois defeitos distintos, medidos na empresa 4:
 *
 * 1) BUSCA. "7º", "7°" e "7⁰" são caracteres DIFERENTES e o `search_name_key` do Postgres
 *    (`regexp_replace(unaccent_lower(x), '[^[:alnum:]]+', ' ')`) trata cada um de um jeito:
 *    'º' e 'ª' são letras para o Postgres e sobrevivem; '°' e '⁰' viram espaço. Medido contra
 *    o grupo "7º ANOS A e B - MATUTINO":
 *      "7º anos" → 2 resultados | "7° anos" → 0 | "7o anos" → 0 | "7 anos" → 0
 *    Como a base mistura as formas ("7º ANOS A e B", "7° Ano C", "7⁰ A e B"), só achava quem
 *    digitasse exatamente o caractere gravado.
 *
 * 2) DUPLICATA. `criarGrupo` lia `conv?.id` de `findOrCreateConversation`, que devolve
 *    `{ conversa, created }`. Sempre undefined → caía no insert de emergência e todo grupo
 *    criado pelo sistema nascia em DUAS linhas: a certa (id @g.us) e uma fantasma com
 *    telefone `grupo_<timestamp>` — que era a devolvida para a tela.
 */

const { gerarVariantesOrdinais, normalizeNameSearchKey, nameMatchesWordPrefix } = require('../helpers/chatSearchHelper')

describe('gerarVariantesOrdinais — as formas do ordinal', () => {
  const ORDINAL = 'º' // º
  const GRAU = '°'    // °
  const SOBRE = '⁰'   // ⁰

  test('termo com ordinal gera as outras formas e a forma com espaço', () => {
    const v = gerarVariantesOrdinais(`7${ORDINAL} anos`)
    expect(v[0]).toBe(`7${ORDINAL} anos`) // o original vem primeiro
    expect(v).toContain(`7${GRAU} anos`)
    expect(v).toContain(`7${SOBRE} anos`)
    expect(v).toContain('7 anos')
  })

  test('termo com GRAU acha o grupo gravado com ordinal', () => {
    expect(gerarVariantesOrdinais(`7${GRAU} anos`)).toContain(`7${ORDINAL} anos`)
  })

  test('termo sem símbolo nenhum também tenta as formas com símbolo', () => {
    const v = gerarVariantesOrdinais('7 anos')
    expect(v).toContain(`7${ORDINAL} anos`)
    expect(v).toContain(`7${GRAU} anos`)
  })

  test('"7o anos" (letra o) também', () => {
    expect(gerarVariantesOrdinais('7o anos')).toContain(`7${ORDINAL} anos`)
  })

  test('termo comum NÃO multiplica consulta — uma variante só', () => {
    expect(gerarVariantesOrdinais('Mural')).toEqual(['Mural'])
    expect(gerarVariantesOrdinais('maria silva')).toEqual(['maria silva'])
  })

  test('não inventa variante para número solto (telefone)', () => {
    expect(gerarVariantesOrdinais('5534999911246')).toEqual(['5534999911246'])
  })

  test('é estável entre chamadas (regex /g guarda lastIndex)', () => {
    const a = gerarVariantesOrdinais(`6${ORDINAL} ano`)
    const b = gerarVariantesOrdinais(`6${ORDINAL} ano`)
    expect(a).toEqual(b)
  })

  test('vazio não quebra', () => {
    expect(gerarVariantesOrdinais('')).toEqual([])
    expect(gerarVariantesOrdinais(null)).toEqual([])
  })
})

describe('filtro defensivo da lista aceita o grupo em qualquer forma', () => {
  const NOME = '7º ANOS A e B - MATUTINO'

  test.each([
    ['7º anos', 'ordinal'],
    ['7° anos', 'grau'],
    ['7 anos', 'sem símbolo'],
    ['matutino', 'palavra do meio'],
  ])('%s (%s) casa com o nome do grupo', (termo) => {
    expect(nameMatchesWordPrefix(NOME, termo)).toBe(true)
  })

  test('a normalização joga os símbolos fora dos dois lados', () => {
    expect(normalizeNameSearchKey(NOME)).toBe('7 anos a e b matutino')
    expect(normalizeNameSearchKey('7° anos')).toBe('7 anos')
  })

  test('termo que não existe no nome continua não casando', () => {
    expect(nameMatchesWordPrefix(NOME, 'vespertino')).toBe(false)
  })
})
