/**
 * Varredura dos mapas de debounce por conversa do chatbot (doc 29 §3 item 14).
 *
 * POR QUE EXISTE: `lastWelcomeSentAt`, `lastOpcaoInvalidaSentAt`, `lastForaHorarioSentAt`
 * e `lastMenuEnviadoServerAt` so' eram limpos no fim do fluxo de triagem. Conversa que
 * nunca chega la' deixava a entrada para SEMPRE — leak lento (estimado 0,3-1 MB/dia).
 *
 * O QUE ESTE TESTE TRAVA:
 *   1. entrada vencida sai dos QUATRO mapas;
 *   2. entrada ainda dentro da retencao FICA — podar cedo reintroduziria menu duplicado,
 *      que e' o bug que estes mapas existem para evitar;
 *   3. a retencao e' confortavelmente maior que a maior janela de debounce (60 s), senao a
 *      varredura passaria a mudar decisao do bot;
 *   4. valor nao-numerico (estado corrompido) e' removido em vez de ficar preso;
 *   5. a varredura nao mantem o processo vivo (timer com `unref`).
 */

const servico = require('../services/chatbotTriageService')

const { pruneDebounceMapsPorConversa, DEBOUNCE_MAPS_RETENCAO_MS, __mapasDebouncePorConversa } = servico

function limparTodos() {
  for (const m of __mapasDebouncePorConversa()) m.clear()
}

beforeEach(limparTodos)
afterAll(limparTodos)

describe('chatbotTriageService — varredura dos mapas de debounce', () => {
  it('expoe os quatro mapas por conversa', () => {
    expect(__mapasDebouncePorConversa()).toHaveLength(4)
  })

  it('remove entradas vencidas de todos os mapas', () => {
    const agora = 1_000_000_000
    const velho = agora - DEBOUNCE_MAPS_RETENCAO_MS - 1
    for (const m of __mapasDebouncePorConversa()) m.set('conversa-1', velho)

    const removidas = pruneDebounceMapsPorConversa(agora)

    expect(removidas).toBe(4)
    for (const m of __mapasDebouncePorConversa()) expect(m.size).toBe(0)
  })

  it('MANTEM entradas dentro da retencao (podar cedo = menu duplicado)', () => {
    const agora = 1_000_000_000
    const recente = agora - 30_000 // 30 s: dentro da janela de "opcao invalida" (60 s)
    for (const m of __mapasDebouncePorConversa()) m.set('conversa-1', recente)

    const removidas = pruneDebounceMapsPorConversa(agora)

    expect(removidas).toBe(0)
    for (const m of __mapasDebouncePorConversa()) expect(m.get('conversa-1')).toBe(recente)
  })

  it('a retencao e muito maior que a maior janela de debounce (60 s)', () => {
    // Se alguem reduzir a retencao para perto da janela, a varredura passa a poder apagar
    // uma entrada que ainda vale — e o bot volta a mandar menu duplicado em rajada.
    expect(DEBOUNCE_MAPS_RETENCAO_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('exatamente no limite da retencao, a entrada e preservada', () => {
    const agora = 1_000_000_000
    const noLimite = agora - DEBOUNCE_MAPS_RETENCAO_MS
    const [primeiro] = __mapasDebouncePorConversa()
    primeiro.set('conversa-1', noLimite)

    expect(pruneDebounceMapsPorConversa(agora)).toBe(0)
    expect(primeiro.get('conversa-1')).toBe(noLimite)
  })

  it('valor nao-numerico e removido em vez de ficar preso', () => {
    const [primeiro] = __mapasDebouncePorConversa()
    primeiro.set('conversa-lixo', undefined)
    primeiro.set('conversa-nan', NaN)
    primeiro.set('conversa-texto', 'ontem')

    pruneDebounceMapsPorConversa(1_000_000_000)

    expect(primeiro.size).toBe(0)
  })

  it('mexe apenas nas chaves vencidas, deixando as outras conversas intactas', () => {
    const agora = 1_000_000_000
    const [primeiro] = __mapasDebouncePorConversa()
    primeiro.set('vencida', agora - DEBOUNCE_MAPS_RETENCAO_MS - 1)
    primeiro.set('viva', agora - 1_000)

    expect(pruneDebounceMapsPorConversa(agora)).toBe(1)
    expect([...primeiro.keys()]).toEqual(['viva'])
  })

  it('o timer da varredura nao mantem o processo vivo', () => {
    // O servico ja' foi carregado acima; se o setInterval nao tivesse `unref`, a suite
    // ficaria pendurada no fim. Travamos a intencao verificando a fonte.
    const fonte = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'chatbotTriageService.js'),
      'utf8'
    )
    expect(fonte).toMatch(/_debouncePruneTimer\.unref === 'function'\) _debouncePruneTimer\.unref\(\)/)
  })
})
