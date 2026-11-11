/**
 * `GET /chats/counts`: `invalidateCountsCache()` durante uma contagem em voo NÃO pode ser
 * desfeita pelo resultado que começou antes dela (visibilidade por número, assumir/encerrar
 * invalidam; um counts em voo recacheava o snapshot velho por um TTL inteiro — 20 s).
 * Conferido a falhar com a mutação (setCachedCounts incondicional após o await).
 */

// Prefixo `mock`: o Jest só permite a fábrica de `jest.mock()` referenciar variáveis assim.
const mockEstado = { total: 0, travar: false, fila: [] }

jest.mock('../config/supabase', () => {
  const esperar = () => (mockEstado.travar ? new Promise((r) => mockEstado.fila.push(r)) : Promise.resolve())
  const fabricarBuilder = () => {
    const resultado = { data: [], count: 0, error: null }
    const builder = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === 'then') return (resolve) => { esperar().then(() => resolve(resultado)) }
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => ({ then: (resolve) => { esperar().then(() => resolve({ data: null, error: null })) } })
          }
          return () => builder
        },
      }
    )
    return builder
  }
  return {
    from: () => { mockEstado.total++; return fabricarBuilder() },
    rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
  }
})

const service = require('../services/chatListCountsService')
const reqDe = (company_id) => ({ user: { company_id, id: 10, perfil: 'admin', departamento_ids: [] }, query: {} })
const liberar = () => { mockEstado.travar = false; mockEstado.fila.splice(0).forEach((r) => r()) }

beforeEach(() => {
  mockEstado.total = 0
  mockEstado.travar = false
  mockEstado.fila = []
  service.invalidateCountsCache()
})

test('invalidateCountsCache() com contagem em voo: a próxima chamada RECOMPUTA', async () => {
  mockEstado.travar = true
  const p1 = service.getChatFilterCounts(reqDe(7))
  await new Promise((r) => setImmediate(r)) // deixa as queries começarem e ficarem presas no portão
  expect(mockEstado.total).toBeGreaterThan(0)

  service.invalidateCountsCache(7) // ex.: admin mudou a visibilidade por número
  liberar()
  await expect(p1).resolves.toEqual(expect.objectContaining({ total: 0 }))

  mockEstado.total = 0
  await service.getChatFilterCounts(reqDe(7))
  expect(mockEstado.total).toBeGreaterThan(0) // sem a checagem de identidade seria 0 (snapshot velho cacheado)
})

test('sem invalidação no meio, a contagem em voo é cacheada normalmente', async () => {
  const a = await service.getChatFilterCounts(reqDe(7))
  mockEstado.total = 0
  const b = await service.getChatFilterCounts(reqDe(7))
  expect(b).toBe(a)
  expect(mockEstado.total).toBe(0)
})
