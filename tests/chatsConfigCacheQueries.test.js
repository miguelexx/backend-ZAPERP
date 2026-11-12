/**
 * Medição (doc 41 §7): quantas chamadas a `supabase.from` um GET /chats e um GET /chats/:id fazem
 * com os caches de configuração FRIOS (= o que TODA chamada custava antes desta sessão) e
 * QUENTES (= o custo em regime, dentro do TTL).
 *
 * Cenário: atendente (não admin) da empresa 1, 1 conversa visível na lista,
 * `incluir_colaboradores_encaminhar=1` (o pior caso, que também lia `usuarios`).
 *
 * O que trava:
 *   - na 2ª chamada da lista somem `departamentos` (Financeiro), `usuarios` (colaboradores),
 *     `ia_config` (alerta sem resposta) e uma das duas leituras de `empresas` (modo simples);
 *   - na 2ª chamada do detalhe somem `empresas` e `ia_config`;
 *   - o corpo JSON e os headers da resposta são IDÊNTICOS entre a chamada fria e a quente.
 */
const mockEstado = { porTabela: {}, total: 0, rows: {}, listas: {} }

jest.mock('../config/supabase', () => {
  const fabricarBuilder = (tabela) => {
    const builder = new Proxy({}, {
      get(_alvo, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve({
            data: mockEstado.listas[tabela] ? [...mockEstado.listas[tabela]] : [], count: 0, error: null,
          }).then(resolve, reject)
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve({ data: mockEstado.rows[tabela] ?? null, error: null })
        }
        return () => builder
      },
    })
    return builder
  }
  return {
    from: (tabela) => {
      mockEstado.porTabela[tabela] = (mockEstado.porTabela[tabela] || 0) + 1
      mockEstado.total++
      return fabricarBuilder(tabela)
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  }
})
jest.mock('../services/ultramsgSyncContact', () => ({ syncConversationContactOnJoin: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../services/ultramsgGroupsSyncService', () => ({ syncConversationGroupOnJoin: jest.fn().mockResolvedValue(undefined) }))

const { listarConversas } = require('../controllers/chat/conversationListController')
const { detalharChat } = require('../controllers/chat/conversationDetailController')
const modoSimples = require('../helpers/empresaModoSimplesFlag')
const financeiro = require('../helpers/financeiroSetorHelper')
const alerta = require('../helpers/reabertaFaltaInteracaoHelper')
const colaboradores = require('../helpers/colaboradoresEncaminharHelper')

function zerarContagem() { mockEstado.porTabela = {}; mockEstado.total = 0 }
function esfriarCaches() {
  modoSimples.invalidateEmpresaModoSimplesCache()
  financeiro.invalidateFinanceiroSetorCache()
  alerta.invalidateAlertaSemRespostaCache()
  colaboradores.invalidateColaboradoresEncaminharCache()
}
const snapshot = () => ({ ...mockEstado.porTabela, total: mockEstado.total })

const response = () => { const res = { set: jest.fn() }; res.status = jest.fn(() => res); res.json = jest.fn(() => res); return res }
const io = { EVENTS: {}, to: jest.fn(() => ({ emit: jest.fn() })) }
const user = { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [3] }
const reqLista = () => ({ query: { incluir_colaboradores_encaminhar: '1' }, user: { ...user }, app: { get: (k) => (k === 'io' ? io : null) } })
const reqDetalhe = () => ({ params: { id: 10 }, query: { limit: 20 }, user: { ...user }, app: { get: (k) => (k === 'io' ? io : null) } })
const flushImmediates = () => new Promise((r) => setImmediate(r))

const CONVERSA = { id: 10, company_id: 1, atendente_id: 2, telefone: '5511999999999', status_atendimento: 'em_atendimento', lida: true }

beforeEach(() => {
  zerarContagem()
  esfriarCaches()
  mockEstado.rows = { conversas: { ...CONVERSA } }
  mockEstado.listas = {
    conversas: [{
      ...CONVERSA, tipo: 'individual', ultima_atividade: '2026-11-10T12:00:00.000Z', criado_em: '2026-11-10T12:00:00.000Z',
      clientes: { id: 5, nome: 'Cliente', telefone: '5511999999999', company_id: 1 },
    }],
  }
})

/** Roda o handler duas vezes (fria → quente) e devolve contagens e respostas. */
async function medir(handler, req) {
  const fria = response()
  await handler(req(), fria)
  await flushImmediates()
  const contFria = snapshot()
  zerarContagem()
  const quente = response()
  await handler(req(), quente)
  await flushImmediates()
  return { contFria, contQuente: snapshot(), fria, quente }
}

test('GET /chats: 2ª página da mesma empresa deixa de ler departamentos, usuarios, ia_config e a flag de empresas', async () => {
  // Aquece o que NÃO é desta sessão (visibilidade por número já tinha cache), para a medição
  // isolar só as quatro leituras de configuração.
  await listarConversas(reqLista(), response())
  esfriarCaches()
  zerarContagem()

  const { contFria, contQuente, fria, quente } = await medir(listarConversas, reqLista)
  expect(fria.status).not.toHaveBeenCalled()
  expect(quente.status).not.toHaveBeenCalled()

  // As 4 leituras cacheadas: 1 query cada, na chamada fria.
  expect(contFria.departamentos).toBe(1)
  expect(contFria.usuarios).toBe(1)
  expect(contFria.ia_config).toBe(1)
  expect(contFria.empresas).toBe(2) // flags da lista (separar/campanhas) + modo simples
  // …e nenhuma delas na quente.
  expect(contQuente.departamentos).toBeUndefined()
  expect(contQuente.usuarios).toBeUndefined()
  expect(contQuente.ia_config).toBeUndefined()
  expect(contQuente.empresas).toBe(1)
  expect(contQuente.total).toBe(contFria.total - 4)

  // A resposta HTTP não muda em nada.
  expect(quente.json.mock.calls[0][0]).toEqual(fria.json.mock.calls[0][0])
  expect(quente.set.mock.calls).toEqual(fria.set.mock.calls)

  // Números do relatório (doc 41 §7).
  // eslint-disable-next-line no-console
  console.log(`[medição] GET /chats — fria: ${contFria.total} queries ${JSON.stringify(contFria)} | quente: ${contQuente.total} ${JSON.stringify(contQuente)}`)
})

test('GET /chats/:id: 2ª abertura na mesma empresa deixa de ler empresas (modo simples) e ia_config (alerta)', async () => {
  await detalharChat(reqDetalhe(), response())
  await flushImmediates()
  esfriarCaches()
  zerarContagem()

  const { contFria, contQuente, fria, quente } = await medir(detalharChat, reqDetalhe)
  expect(fria.status).not.toHaveBeenCalled()
  expect(quente.status).not.toHaveBeenCalled()

  expect(contFria.empresas).toBe(1)
  expect(contFria.ia_config).toBe(1)
  expect(contQuente.empresas).toBeUndefined()
  expect(contQuente.ia_config).toBeUndefined()
  expect(contQuente.total).toBe(contFria.total - 2)

  expect(quente.json.mock.calls[0][0]).toEqual(fria.json.mock.calls[0][0])

  // eslint-disable-next-line no-console
  console.log(`[medição] GET /chats/:id — fria: ${contFria.total} queries ${JSON.stringify(contFria)} | quente: ${contQuente.total} ${JSON.stringify(contQuente)}`)
})
