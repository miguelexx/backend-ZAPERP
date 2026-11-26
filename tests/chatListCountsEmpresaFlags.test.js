/**
 * Flags da empresa nos contadores (GET /chats/counts) — bug de 26/11/2026.
 *
 * Sintoma: dar F5 às vezes mostrava "Aguardando atendente 0" e, no F5 seguinte, 12.
 * Causa: `resolveChatListCountsContext` lia `empresas` e IGNORAVA o `{ error }` do
 * supabase-js (que não lança). Um soluço do banco virava "empresa sem modo simples", o
 * contador de Aguardando atendente saía 0 e esse resultado errado ficava 20 s no cache.
 *
 * O que fica travado:
 *   (a) erro ao ler a empresa REJEITA a contagem (nada de zero inventado) e não é cacheado:
 *       a chamada seguinte, com o banco de volta, conta de verdade;
 *   (b) com modo simples ligado, "Aguardando atendente" é contado (não sai 0).
 */

const mockEstado = { falharEmpresas: false, modoSimples: true, countConversas: 7 }

jest.mock('../config/supabase', () => {
  const fabricarBuilder = (tabela) => {
    const builder = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === 'then') {
            return (resolve) =>
              resolve({
                data: [],
                count: tabela === 'conversas' ? mockEstado.countConversas : 0,
                error: null,
              })
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => ({
              then: (resolve) => {
                if (tabela === 'empresas' && mockEstado.falharEmpresas) {
                  return resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })
                }
                if (tabela === 'empresas') {
                  return resolve({
                    data: {
                      atendimento_modo_simples: mockEstado.modoSimples,
                      separar_mensagens_disparadas: false,
                      modulo_campanhas_ativo: false,
                    },
                    error: null,
                  })
                }
                return resolve({ data: null, error: null })
              },
            })
          }
          return () => builder
        },
      }
    )
    return builder
  }
  return {
    from: (tabela) => fabricarBuilder(tabela),
    rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
  }
})

const service = require('../services/chatListCountsService')
const { invalidateEmpresaModoSimplesCache } = require('../helpers/empresaModoSimplesFlag')

function reqDe(company_id = 1) {
  return { user: { company_id, id: 10, perfil: 'admin', departamento_ids: [] }, query: {} }
}

beforeEach(() => {
  mockEstado.falharEmpresas = false
  mockEstado.modoSimples = true
  service.invalidateCountsCache()
  invalidateEmpresaModoSimplesCache()
})

test('(a) erro ao ler a empresa rejeita a contagem e não fica cacheado', async () => {
  mockEstado.falharEmpresas = true
  await expect(service.getChatFilterCounts(reqDe())).rejects.toBeTruthy()

  mockEstado.falharEmpresas = false
  const counts = await service.getChatFilterCounts(reqDe())
  expect(counts.aguardando_atendente).toBe(7)
})

test('(b) modo simples ligado: Aguardando atendente é contado', async () => {
  const counts = await service.getChatFilterCounts(reqDe())
  expect(counts.aguardando_atendente).toBe(7)
})

test('(b) modo simples desligado: Aguardando atendente é 0 (regra não mudou)', async () => {
  mockEstado.modoSimples = false
  const counts = await service.getChatFilterCounts(reqDe())
  expect(counts.aguardando_atendente).toBe(0)
})
