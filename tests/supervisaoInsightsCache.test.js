/**
 * Cache + coalescing de `buildConversationInsights` (doc 29 §backlog item 7).
 *
 * POR QUE EXISTE: `getResumo` e `getClientesPendentes` correm a cada 30 s **por aba de
 * admin aberta**, e cada um varre todas as conversas abertas mais as mensagens do dia,
 * sem teto. O doc 29 chama a isto "o maior consumidor recorrente de CPU/banco".
 *
 * A raiz do custo e' `buildConversationInsights` — 6 queries, incluindo
 * `listLastMessagesByConversation` sobre TODAS as conversas abertas — chamado de SETE
 * sitios do servico.
 *
 * O que este teste trava:
 *   1. segunda chamada dentro do TTL nao toca no banco;
 *   2. chamadas concorrentes partilham UMA execucao (coalescing) — e' o caso real de
 *      varias abas de admin a fazer poll ao mesmo tempo;
 *   3. a chave e' o company_id: empresa B nunca recebe dados de A (o isolamento aqui e'
 *      app-layer, o SERVICE_ROLE bypassa RLS);
 *   4. passado o TTL, volta a consultar;
 *   5. falha NAO e' cacheada (senao um soluco do banco congelava o painel por 15 s).
 */

// Prefixo `mock`: o Jest so' permite a fabrica de `jest.mock()` referenciar
// variaveis assim nomeadas (guarda contra variavel ainda nao inicializada).
const mockEstado = { porTabela: {}, total: 0, falhar: false }

jest.mock('../config/supabase', () => ({
  from: (tabela) => {
    mockEstado.porTabela[tabela] = (mockEstado.porTabela[tabela] || 0) + 1
    mockEstado.total++
    // LANCA de verdade: devolver `{ error }` nao basta — os helpers do servico
    // engolem o erro e devolvem vazio, e aí o caminho de falha nunca corria
    // (o teste passava com o cache de falha ligado, ou seja, nao provava nada).
    if (mockEstado.falhar) throw new Error('falha simulada do banco')
    const resultado = { data: [], error: null }
    const builder = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === 'then') return (resolve) => resolve(resultado)
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => ({ then: (resolve) => resolve({ data: null, error: resultado.error }) })
          }
          return () => builder
        },
      }
    )
    return builder
  },
  rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
}))

const supervisaoService = require('../services/supervisaoService')

function zerarContadores() {
  mockEstado.porTabela = {}
  mockEstado.total = 0
  mockEstado.falhar = false
}

beforeEach(() => {
  zerarContadores()
  supervisaoService.invalidarSupervisaoInsights()
})

describe('supervisaoService — cache de insights', () => {
  it('a segunda chamada dentro do TTL nao toca no banco', async () => {
    await supervisaoService.getResumo(1)
    const naPrimeira = mockEstado.total
    expect(naPrimeira).toBeGreaterThan(0)

    zerarContadores()
    await supervisaoService.getResumo(1)

    // getResumo ainda faz as suas proprias queries (usuarios, atendimentos do dia);
    // o que NAO pode repetir sao as da construcao dos insights.
    expect(mockEstado.porTabela.conversas || 0).toBe(0)
    expect(mockEstado.total).toBeLessThan(naPrimeira)
  })

  it('chamadas concorrentes partilham UMA execucao (coalescing)', async () => {
    const [a, b, c] = await Promise.all([
      supervisaoService.getResumo(1),
      supervisaoService.getClientesPendentes(1, {}),
      supervisaoService.getResumo(1),
    ])
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(c).toBeTruthy()
    // Sem coalescing, tres entradas concorrentes construiriam insights tres vezes.
    expect(mockEstado.porTabela.conversas || 0).toBeLessThanOrEqual(1)
  })

  it('a chave e o company_id: empresa B nao reutiliza o cache de A', async () => {
    await supervisaoService.getResumo(1)
    zerarContadores()
    await supervisaoService.getResumo(2)
    expect(mockEstado.porTabela.conversas || 0).toBeGreaterThan(0)
  })

  it('passado o TTL, volta a consultar', async () => {
    const agoraReal = Date.now
    try {
      let relogio = 1_000_000
      Date.now = () => relogio

      await supervisaoService.getResumo(1)
      zerarContadores()

      relogio += supervisaoService.SUPERVISAO_INSIGHTS_TTL_MS + 1
      await supervisaoService.getResumo(1)

      expect(mockEstado.porTabela.conversas || 0).toBeGreaterThan(0)
    } finally {
      Date.now = agoraReal
    }
  })

  it('falha do banco NAO e cacheada', async () => {
    mockEstado.falhar = true
    let lancou = false
    await supervisaoService.getResumo(1).catch(() => { lancou = true })
    // Garante que o caminho de erro foi mesmo exercitado — sem isto o teste
    // passaria mesmo com a falha a ser cacheada.
    expect(lancou).toBe(true)

    mockEstado.falhar = false
    zerarContadores()
    await supervisaoService.getResumo(1).catch(() => null)

    expect(mockEstado.porTabela.conversas || 0).toBeGreaterThan(0)
  })
})
