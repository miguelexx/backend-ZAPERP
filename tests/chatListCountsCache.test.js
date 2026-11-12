/**
 * Cache + coalescing de `getChatFilterCounts` (GET /chats/counts) — doc 41 §7.
 *
 * POR QUE EXISTE: o frontend chama `/chats/counts` em cada flush de reconciliação da lista
 * (a cada 6 eventos ou 5 s por aba ativa) e cada chamada sem cache roda ~14 counts em
 * paralelo. Duas abas do mesmo usuário, ou flushes de abas diferentes no mesmo segundo,
 * rodavam tudo duas vezes.
 *
 * O que este teste trava (cada caso foi conferido a FALHAR com a mutação correspondente):
 *   (a) duas chamadas concorrentes com a mesma chave executam as counts UMA vez
 *       (mutação: não guardar a promessa em voo);
 *   (b) chaves de empresas diferentes nunca partilham — o isolamento aqui é app-layer,
 *       o SERVICE_ROLE bypassa RLS (mutação: chave sem company_id);
 *   (c) falha não fica cacheada (mutação: não apagar a entrada em voo no catch);
 *   (d) o TTL lê `CHAT_COUNTS_CACHE_TTL_MS`, default 20 s (mutação: TTL fixo em 10 s).
 */

// Prefixo `mock`: o Jest só permite a fábrica de `jest.mock()` referenciar variáveis assim.
const mockEstado = { porTabela: {}, total: 0, falharConversas: false }

jest.mock('../config/supabase', () => {
  const fabricarBuilder = (tabela) => {
    const resultado = { data: [], count: 0, error: null }
    const builder = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === 'then') return (resolve) => resolve(resultado)
          if (prop === 'select') {
            return (...args) => {
              // A sonda do backfill de tem_mensagem (`mensagens!inner`, 1× por processo) não é
              // uma count: não entra na régua de "quantas queries uma chamada fria faz".
              if (!String(args[0] || '').includes('mensagens!inner')) {
                mockEstado.porTabela[tabela] = (mockEstado.porTabela[tabela] || 0) + 1
                mockEstado.total++
              }
              return builder
            }
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => ({ then: (resolve) => resolve({ data: null, error: null }) })
          }
          return () => builder
        },
      }
    )
    return builder
  }
  return {
    from: (tabela) => {
      // LANÇA de verdade (devolver `{ error }` não basta: o caminho de falha tem de rejeitar
      // a promessa inteira para provar que a entrada em voo sai do mapa).
      if (tabela === 'conversas' && mockEstado.falharConversas) {
        throw new Error('falha simulada do banco')
      }
      return fabricarBuilder(tabela)
    },
    rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
  }
})

const service = require('../services/chatListCountsService')

function zerar() {
  mockEstado.porTabela = {}
  mockEstado.total = 0
  mockEstado.falharConversas = false
}

function reqDe(company_id, user_id = 10, query = {}) {
  return { user: { company_id, id: user_id, perfil: 'admin', departamento_ids: [] }, query }
}

const conversasQueries = () => mockEstado.porTabela.conversas || 0

/** Quantas queries em `conversas` uma chamada fria faz — a régua dos outros casos. */
async function medirChamadaFria() {
  zerar()
  service.invalidateCountsCache()
  await service.getChatFilterCounts(reqDe(1))
  const n = conversasQueries()
  expect(n).toBeGreaterThan(0)
  return n
}

beforeEach(() => {
  zerar()
  delete process.env.CHAT_COUNTS_CACHE_TTL_MS
  service.invalidateCountsCache()
})

afterAll(() => {
  delete process.env.CHAT_COUNTS_CACHE_TTL_MS
})

describe('getChatFilterCounts — cache e coalescing', () => {
  it('(a) duas chamadas concorrentes com a mesma chave executam as counts UMA vez', async () => {
    const n = await medirChamadaFria()

    zerar()
    service.invalidateCountsCache()
    const [a, b] = await Promise.all([
      service.getChatFilterCounts(reqDe(1)),
      service.getChatFilterCounts(reqDe(1)),
    ])

    // Sem coalescing seriam 2 × n.
    expect(conversasQueries()).toBe(n)
    // Mesma promessa partilhada => mesmo objeto de resultado.
    expect(a).toBe(b)
    expect(a).toEqual(expect.objectContaining({ total: 0, minha_fila: 0, hoje: 0 }))
  })

  it('(a2) a segunda chamada dentro do TTL não toca no banco e o formato da resposta é o mesmo', async () => {
    const primeira = await service.getChatFilterCounts(reqDe(1))
    zerar()
    const segunda = await service.getChatFilterCounts(reqDe(1))
    expect(mockEstado.total).toBe(0)
    expect(segunda).toBe(primeira)
    expect(Object.keys(primeira).sort()).toEqual(
      [
        'total', 'minha_fila', 'hoje', 'abertas', 'em_atendimento', 'finalizadas', 'por_ausencia',
        'aguardando_cliente', 'aguardando_atendente', 'pagamentos_pendentes', 'em_atraso',
        'transferidos', 'mensagens_disparadas', 'campanhas', 'aguardando', 'atraso',
      ].sort()
    )
  })

  it('(b) chaves de empresas diferentes nunca partilham (mesmo user_id e filtros)', async () => {
    const n = await medirChamadaFria()

    zerar()
    service.invalidateCountsCache()
    const [a, b] = await Promise.all([
      service.getChatFilterCounts(reqDe(1, 10)),
      service.getChatFilterCounts(reqDe(2, 10)),
    ])
    // Empresas diferentes => duas execuções completas, nunca uma partilhada.
    expect(conversasQueries()).toBe(2 * n)
    expect(a).not.toBe(b)

    // E o cache resolvido também é por empresa: B quente não serve A frio.
    service.invalidateCountsCache(1)
    zerar()
    await service.getChatFilterCounts(reqDe(2, 10))
    expect(conversasQueries()).toBe(0)
    await service.getChatFilterCounts(reqDe(1, 10))
    expect(conversasQueries()).toBe(n)
  })

  it('(b2) invalidateCountsCache(company_id) apaga só a empresa pedida', async () => {
    const n = await medirChamadaFria()
    await service.getChatFilterCounts(reqDe(2))

    service.invalidateCountsCache(2)
    zerar()
    await service.getChatFilterCounts(reqDe(1))
    expect(conversasQueries()).toBe(0)
    await service.getChatFilterCounts(reqDe(2))
    expect(conversasQueries()).toBe(n)
  })

  it('(c) falha não fica cacheada: a chamada seguinte volta ao banco', async () => {
    mockEstado.falharConversas = true
    let lancou = false
    await service.getChatFilterCounts(reqDe(1)).catch(() => { lancou = true })
    // Garante que o caminho de erro foi mesmo exercitado.
    expect(lancou).toBe(true)

    mockEstado.falharConversas = false
    zerar()
    // Sem o `delete` no catch, a promessa rejeitada ficaria presa na entrada em voo e esta
    // chamada rejeitaria de novo sem tocar no banco.
    await expect(service.getChatFilterCounts(reqDe(1))).resolves.toBeTruthy()
    expect(conversasQueries()).toBeGreaterThan(0)
  })

  it('(c2) concorrentes durante a falha partilham a rejeição, e a próxima chamada recomeça limpa', async () => {
    mockEstado.falharConversas = true
    const resultados = await Promise.allSettled([
      service.getChatFilterCounts(reqDe(1)),
      service.getChatFilterCounts(reqDe(1)),
    ])
    expect(resultados.map((r) => r.status)).toEqual(['rejected', 'rejected'])

    mockEstado.falharConversas = false
    zerar()
    await expect(service.getChatFilterCounts(reqDe(1))).resolves.toBeTruthy()
    expect(conversasQueries()).toBeGreaterThan(0)
  })
})

describe('getChatFilterCounts — TTL via CHAT_COUNTS_CACHE_TTL_MS', () => {
  it('getChatCountsCacheTtlMs: default 20000, lê a env, ignora inválido e limita a faixa', () => {
    delete process.env.CHAT_COUNTS_CACHE_TTL_MS
    expect(service.getChatCountsCacheTtlMs()).toBe(20000)
    process.env.CHAT_COUNTS_CACHE_TTL_MS = '30000'
    expect(service.getChatCountsCacheTtlMs()).toBe(30000)
    process.env.CHAT_COUNTS_CACHE_TTL_MS = 'abc'
    expect(service.getChatCountsCacheTtlMs()).toBe(20000)
    process.env.CHAT_COUNTS_CACHE_TTL_MS = '0'
    expect(service.getChatCountsCacheTtlMs()).toBe(20000)
    process.env.CHAT_COUNTS_CACHE_TTL_MS = '10'
    expect(service.getChatCountsCacheTtlMs()).toBe(1000)
    process.env.CHAT_COUNTS_CACHE_TTL_MS = '999999999'
    expect(service.getChatCountsCacheTtlMs()).toBe(300000)
  })

  it('(d) sem env: 15 s depois ainda serve do cache (default 20 s, não os 10 s antigos); 20 s depois reconsulta', async () => {
    const agoraReal = Date.now
    try {
      let relogio = 1_000_000
      Date.now = () => relogio

      await service.getChatFilterCounts(reqDe(1))
      zerar()

      relogio += 15_000
      await service.getChatFilterCounts(reqDe(1))
      expect(mockEstado.total).toBe(0)

      relogio += 5_001
      await service.getChatFilterCounts(reqDe(1))
      expect(conversasQueries()).toBeGreaterThan(0)
    } finally {
      Date.now = agoraReal
    }
  })

  it('(d2) com CHAT_COUNTS_CACHE_TTL_MS=1000: 1,5 s depois já reconsulta', async () => {
    process.env.CHAT_COUNTS_CACHE_TTL_MS = '1000'
    const agoraReal = Date.now
    try {
      let relogio = 2_000_000
      Date.now = () => relogio

      await service.getChatFilterCounts(reqDe(1))
      zerar()

      relogio += 1_500
      await service.getChatFilterCounts(reqDe(1))
      expect(conversasQueries()).toBeGreaterThan(0)
    } finally {
      Date.now = agoraReal
    }
  })
})
