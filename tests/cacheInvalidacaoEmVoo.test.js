/**
 * `shortTtlCache`: invalidação durante uma leitura em voo NÃO pode ser desfeita pelo resultado antigo.
 *
 * Cenário real: o admin salva Configurações (modo simples / setores / alerta / usuários) 20 ms
 * depois de um `GET /chats` ter começado. O mutador invalida o cache; a leitura antiga resolve
 * e, sem a checagem de identidade, regravava o valor VELHO por um TTL inteiro. Os 4 caches de
 * configuração da lista/detalhe dependem deste helper. (O cache de `/chats/counts` tem o mesmo
 * cenário em `tests/countsInvalidacaoEmVoo.test.js`.)
 * Cada caso foi conferido a falhar com a mutação (gravar incondicionalmente).
 */
const { create } = require('../helpers/shortTtlCache')

function deferido() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('shortTtlCache — invalidação com leitura em voo', () => {
  test('invalidate() durante o loader: o valor antigo NÃO é recacheado', async () => {
    const cache = create({ name: 'teste', ttlMs: 60_000 })
    const d = deferido()
    const emVoo = cache.wrap(1, 'flag', () => d.promise)

    cache.invalidate(1) // admin salvou no meio
    d.resolve('ANTIGO')
    await expect(emVoo).resolves.toBe('ANTIGO') // quem esperava recebe o que leu

    let chamadas = 0
    const depois = await cache.wrap(1, 'flag', async () => { chamadas++; return 'NOVO' })
    expect(depois).toBe('NOVO')
    expect(chamadas).toBe(1) // reconsultou: a invalidação valeu
  })

  test('sem invalidação no meio, o resultado é cacheado normalmente', async () => {
    const cache = create({ name: 'teste2', ttlMs: 60_000 })
    let chamadas = 0
    await cache.wrap(1, 'flag', async () => { chamadas++; return 'A' })
    const v = await cache.wrap(1, 'flag', async () => { chamadas++; return 'B' })
    expect(v).toBe('A')
    expect(chamadas).toBe(1)
  })

  test('falha em voo após invalidação não apaga a entrada nova de outra leitura', async () => {
    const cache = create({ name: 'teste3', ttlMs: 60_000 })
    const d = deferido()
    const emVoo = cache.wrap(1, 'flag', () => d.promise)
    cache.invalidate(1)
    const nova = await cache.wrap(1, 'flag', async () => 'NOVO')
    expect(nova).toBe('NOVO')
    d.reject(new Error('timeout'))
    await expect(emVoo).rejects.toThrow('timeout')
    let chamadas = 0
    const v = await cache.wrap(1, 'flag', async () => { chamadas++; return 'OUTRO' })
    expect(v).toBe('NOVO') // a entrada nova sobreviveu à falha da antiga
    expect(chamadas).toBe(0)
  })
})
