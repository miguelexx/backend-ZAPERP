/**
 * Poda de mapas em memoria por idade (doc 29 §3 item 14, resto do item).
 *
 * POR QUE EXISTE: a varredura anterior cobriu os 4 mapas do chatbot, mas o item tambem
 * citava `_lastSyncByConv` — e esse, com o `_lastFotoRefreshByConv`, continuava sem poda em
 * `services/ultramsgSyncContact.js`. Chave e `company_id:conversa_id`, nada apagava, logo
 * cresciam para sempre desde o boot.
 *
 * A ARMADILHA QUE ESTE TESTE TRAVA: os dois mapas protegem janelas MUITO diferentes — 60 s
 * para o sync, **6 h** para a reconsulta de foto. Uma retencao unica (a menor) apagaria a
 * marca da foto antes das 6 h e o servico voltaria a bater no provedor em rajada, que e
 * exatamente o que o `FOTO_REFRESH_TTL_MS` existe para evitar. Por isso as retencoes sao
 * separadas, e ha aqui um teste que falha se alguem as unificar.
 */

const { pruneMapaPorIdade, agendarVarredura } = require('../helpers/pruneMapaPorIdade')

describe('pruneMapaPorIdade', () => {
  it('remove o que passou da retencao e mantem o resto', () => {
    const agora = 1_000_000_000
    const m = new Map([
      ['vencida', agora - 10_001],
      ['viva', agora - 5_000],
    ])
    expect(pruneMapaPorIdade(m, 10_000, agora)).toBe(1)
    expect([...m.keys()]).toEqual(['viva'])
  })

  it('o limite da retencao e inclusivo (no limite, preserva)', () => {
    const agora = 1_000_000_000
    const m = new Map([['limite', agora - 10_000]])
    expect(pruneMapaPorIdade(m, 10_000, agora)).toBe(0)
    expect(m.has('limite')).toBe(true)
  })

  it('remove valor nao-numerico em vez de deixa-lo preso', () => {
    const m = new Map([['a', undefined], ['b', NaN], ['c', 'ontem'], ['d', null]])
    expect(pruneMapaPorIdade(m, 10_000, 1_000_000_000)).toBe(4)
    expect(m.size).toBe(0)
  })

  it('entrada invalida nao quebra nem apaga nada', () => {
    expect(pruneMapaPorIdade(null, 10_000)).toBe(0)
    expect(pruneMapaPorIdade(undefined, 10_000)).toBe(0)
    expect(pruneMapaPorIdade({}, 10_000)).toBe(0)
    const m = new Map([['a', 1]])
    expect(pruneMapaPorIdade(m, 0)).toBe(0)
    expect(pruneMapaPorIdade(m, -5)).toBe(0)
    expect(pruneMapaPorIdade(m, NaN)).toBe(0)
    expect(m.size).toBe(1)
  })

  it('agendarVarredura devolve timer com unref aplicado', () => {
    let correu = false
    const t = agendarVarredura(() => void (correu = true), 60_000)
    expect(typeof t.unref).toBe('function')
    // `hasRef()` do Node diz se o timer segura o event loop; depois de unref, false.
    if (typeof t.hasRef === 'function') expect(t.hasRef()).toBe(false)
    clearInterval(t)
    expect(correu).toBe(false) // nao corre de imediato, so no intervalo
  })
})

describe('ultramsgSyncContact — varredura dos mapas de sync', () => {
  const servico = require('../services/ultramsgSyncContact')
  const { pruneMapasDeSync, SYNC_RETENCAO_MS, FOTO_RETENCAO_MS, __mapasDeSync } = servico
  const [mapaSync, mapaFoto] = __mapasDeSync()

  beforeEach(() => {
    mapaSync.clear()
    mapaFoto.clear()
  })
  afterAll(() => {
    mapaSync.clear()
    mapaFoto.clear()
  })

  it('expoe os dois mapas', () => {
    expect(__mapasDeSync()).toHaveLength(2)
  })

  it('remove entradas vencidas dos dois', () => {
    const agora = 2_000_000_000
    mapaSync.set('1:10', agora - SYNC_RETENCAO_MS - 1)
    mapaFoto.set('1:10', agora - FOTO_RETENCAO_MS - 1)
    expect(pruneMapasDeSync(agora)).toBe(2)
    expect(mapaSync.size).toBe(0)
    expect(mapaFoto.size).toBe(0)
  })

  it('a marca da FOTO sobrevive a uma varredura 10 min depois (nao reconsulta em rajada)', () => {
    const agora = 2_000_000_000
    // cenario real: foto consultada agora; varredura corre 10 min depois.
    mapaFoto.set('1:10', agora)
    mapaSync.set('1:10', agora)
    const dezMinDepois = agora + 10 * 60 * 1000

    pruneMapasDeSync(dezMinDepois)

    expect(mapaFoto.get('1:10')).toBe(agora) // ESSENCIAL: a janela de 6 h continua valendo
    expect(mapaSync.get('1:10')).toBe(agora) // 10 min nao passa a retencao de sync tambem
  })

  it('a marca da foto sobrevive a 5 h e some depois das 6 h + folga', () => {
    const agora = 2_000_000_000
    mapaFoto.set('1:10', agora)
    pruneMapasDeSync(agora + 5 * 60 * 60 * 1000)
    expect(mapaFoto.has('1:10')).toBe(true)

    pruneMapasDeSync(agora + FOTO_RETENCAO_MS + 1)
    expect(mapaFoto.has('1:10')).toBe(false)
  })

  it('as retencoes sao SEPARADAS e cada uma folgada em relacao a sua janela', () => {
    // Unificar as duas (usando a menor) e o erro que reintroduz a rajada de foto.
    expect(FOTO_RETENCAO_MS).toBeGreaterThan(SYNC_RETENCAO_MS)
    expect(FOTO_RETENCAO_MS).toBeGreaterThan(6 * 60 * 60 * 1000) // > FOTO_REFRESH_TTL_MS
    expect(SYNC_RETENCAO_MS).toBeGreaterThanOrEqual(5 * 60_000) // >> SYNC_DEBOUNCE_MS (60 s)
  })
})
