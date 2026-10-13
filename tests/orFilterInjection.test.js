const { escapeIlikePattern, quoteOrValue } = require('../helpers/chatSearchHelper')

/**
 * No PostgREST o argumento de `.or()` é uma STRING com gramática própria: vírgula separa
 * condições e parênteses agrupam. Interpolar texto do usuário cru ali deixa de ser "um
 * valor" e passa a ser estrutura — um nome banal como "Silva, Maria" vira duas condições,
 * e um telefone mascarado "+55 (34) 9991-1246" quebra o parser do filtro inteiro.
 *
 * Auditoria 10/10/2026: três pontos montavam o filtro sem esse cuidado —
 * `repositories/internalChatRepository.js`, `services/aiDashboard/resolveEntities.js` e
 * `controllers/disparoDestinatariosController.js` — enquanto a busca de conversas já fazia
 * certo com `escapeIlikePattern` + `quoteOrValue`. Estes testes travam a composição.
 *
 * Importante: isolamento entre empresas NUNCA dependeu disto. `company_id` entra como
 * `.eq()` separado (um AND), fora do alcance do `or`.
 */

/** Divide o `.or(...)` em condições de topo, ignorando vírgulas dentro de aspas. */
function dividirCondicoes(expr) {
  const partes = []
  let atual = ''
  let dentroDeAspas = false
  let escapando = false
  for (const ch of expr) {
    if (escapando) { atual += ch; escapando = false; continue }
    if (ch === '\\') { atual += ch; escapando = true; continue }
    if (ch === '"') { dentroDeAspas = !dentroDeAspas; atual += ch; continue }
    if (ch === ',' && !dentroDeAspas) { partes.push(atual); atual = ''; continue }
    atual += ch
  }
  partes.push(atual)
  return partes
}

const TERMOS_PERIGOSOS = [
  'Silva, Maria',
  '+55 (34) 9991-1246',
  'a,b,c,d',
  'x)or(y',
  'nome.ilike.*',
  '100% algodão',
  'under_score',
  'barra\\invertida',
  'aspas"no"meio',
]

describe('filtros .or() do PostgREST não podem ser reescritos pelo termo buscado', () => {
  test.each(TERMOS_PERIGOSOS)('chat interno mantém 3 condições com %j', (termo) => {
    const term = quoteOrValue(`%${escapeIlikePattern(termo)}%`)
    const expr = `nome.ilike.${term},pushname.ilike.${term},telefone.ilike.${term}`
    expect(dividirCondicoes(expr)).toHaveLength(3)
  })

  test.each(TERMOS_PERIGOSOS)('destinatários do disparo mantêm 2 condições com %j', (termo) => {
    const nome = quoteOrValue(`%${escapeIlikePattern(termo)}%`)
    const telefone = quoteOrValue(`%${String(termo).replace(/\D/g, '')}%`)
    const expr = `nome.ilike.${nome},telefone_normalizado.ilike.${telefone}`
    expect(dividirCondicoes(expr)).toHaveLength(2)
  })

  test.each(TERMOS_PERIGOSOS)('resolução de cliente da IA mantém 2 condições com %j', (termo) => {
    const term = quoteOrValue(`%${escapeIlikePattern(termo)}%`)
    const expr = `nome.ilike.${term},pushname.ilike.${term}`
    expect(dividirCondicoes(expr)).toHaveLength(2)
  })

  test('sem o tratamento o termo REALMENTE quebraria o filtro (senão o teste não prova nada)', () => {
    const cru = `nome.ilike.%Silva, Maria%,pushname.ilike.%Silva, Maria%`
    expect(dividirCondicoes(cru).length).toBeGreaterThan(2)
  })

  test('o termo continua literal — citar não é mutilar', () => {
    const term = quoteOrValue(`%${escapeIlikePattern('Silva, Maria')}%`)
    expect(term).toContain('Silva, Maria')
  })

  test('curingas do ILIKE digitados pelo usuário viram texto, não wildcard', () => {
    // escapeIlikePattern marca o % do usuário com \; quoteOrValue dobra a \ ao citar.
    expect(escapeIlikePattern('100%')).toBe('100\\%')
    const term = quoteOrValue(`%${escapeIlikePattern('100%')}%`)
    expect(term).toBe('"%100\\\\%%"')
    // Os % das pontas seguem como curinga de verdade (busca "contém").
    expect(term.startsWith('"%')).toBe(true)
    expect(term.endsWith('%"')).toBe(true)
  })
})
