/**
 * Fila serial por conversa: ordem preservada por chave, paralelismo entre chaves, isolamento de falha.
 */
const { enqueueSerialByKey, activeKeyCount, _chains } = require('../helpers/serialDispatchQueue')

const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  _chains.clear()
})

test('mesma chave: tarefas rodam em série na ordem de enfileiramento', async () => {
  const order = []
  const mkTask = (id, ms) => async () => {
    order.push(`start-${id}`)
    await sleep(ms)
    order.push(`end-${id}`)
  }
  // A demora mais que B; ainda assim B só começa após A terminar (mesma chave).
  const pA = enqueueSerialByKey('c:1', mkTask('A', 30))
  const pB = enqueueSerialByKey('c:1', mkTask('B', 1))
  await Promise.all([pA, pB])
  expect(order).toEqual(['start-A', 'end-A', 'start-B', 'end-B'])
})

test('chaves diferentes rodam em paralelo', async () => {
  const order = []
  const pA = enqueueSerialByKey('c:1', async () => {
    order.push('start-A')
    await sleep(30)
    order.push('end-A')
  })
  const pB = enqueueSerialByKey('c:2', async () => {
    order.push('start-B')
    await sleep(1)
    order.push('end-B')
  })
  await Promise.all([pA, pB])
  // B (chave diferente) termina antes de A, provando que não serializou entre chaves.
  expect(order.indexOf('end-B')).toBeLessThan(order.indexOf('end-A'))
})

test('falha de uma task não bloqueia a próxima da mesma chave', async () => {
  const order = []
  const pA = enqueueSerialByKey('c:1', async () => {
    order.push('A')
    throw new Error('falha A')
  })
  const pB = enqueueSerialByKey('c:1', async () => {
    order.push('B')
  })
  await expect(pA).rejects.toThrow('falha A')
  await pB
  expect(order).toEqual(['A', 'B'])
})

test('limpa a entrada do mapa quando a cadeia esvazia', async () => {
  await enqueueSerialByKey('c:9', async () => {})
  await tick()
  await tick()
  expect(activeKeyCount()).toBe(0)
})
