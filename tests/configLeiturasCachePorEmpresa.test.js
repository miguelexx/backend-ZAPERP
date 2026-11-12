/**
 * Cache por `company_id` das leituras de CONFIGURAÇÃO que rodavam em TODA chamada de
 * GET /chats e GET /chats/:id (doc 41 §7):
 *
 *   1. `empresaModoSimplesAtivo`          — `empresas.atendimento_modo_simples`   (TTL 30 s)
 *   2. `obterDepartamentoIdsFinanceiro`   — `departamentos` inteira da empresa      (TTL 60 s)
 *   3. `isAlertaSemRespostaAtivo`         — `ia_config.config.alerta_sem_resposta` (TTL 30 s)
 *   4. `listarColaboradoresEncaminhar`    — `usuarios` ativos da empresa            (TTL 60 s)
 *
 * O que este arquivo trava, por helper (cada caso conferido a FALHAR com a mutação indicada):
 *   (a) 2ª chamada da mesma empresa não vai ao banco           (mutação: não usar o cache);
 *   (b) empresas diferentes nunca partilham a entrada — o isolamento é app-layer, o
 *       SERVICE_ROLE bypassa RLS                               (mutação: chave fixa, sem company_id);
 *   (c) falha do banco devolve o fallback de sempre e NÃO fica cacheada
 *                                                              (mutação: loader devolve o fallback em vez de lançar);
 *   (d) cada mutador invalida a entrada da empresa             (mutação: remover a chamada de invalidate);
 *   (e) o formato devolvido é o de antes (4: ordem do banco, `neq(id, user_id)` em memória).
 */

// Prefixo `mock`: o Jest só permite a fábrica de `jest.mock()` referenciar variáveis assim.
const mockDb = { chamadas: [], responder: () => ({ data: null, error: null }) }

jest.mock('../config/supabase', () => {
  const fabricarBuilder = (tabela) => {
    const chamada = { tabela, ops: [] }
    mockDb.chamadas.push(chamada)
    const executar = () => Promise.resolve().then(() => mockDb.responder(chamada))
    const builder = new Proxy({}, {
      get(_alvo, prop) {
        if (prop === 'then') return (resolve, reject) => executar().then(resolve, reject)
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => { chamada.ops.push([prop, []]); return executar() }
        }
        return (...args) => { chamada.ops.push([prop, args]); return builder }
      },
    })
    return builder
  }
  return { from: (tabela) => fabricarBuilder(tabela), rpc: () => Promise.resolve({ data: [], error: null }) }
})
jest.mock('../services/crmSyncService', () => ({ isEnabled: () => false, syncEmpresa: jest.fn(), syncUsuario: jest.fn(), syncContato: jest.fn(), syncLead: jest.fn() }))

const modoSimples = require('../helpers/empresaModoSimplesFlag')
const financeiro = require('../helpers/financeiroSetorHelper')
const alerta = require('../helpers/reabertaFaltaInteracaoHelper')
const colaboradores = require('../helpers/colaboradoresEncaminharHelper')

/** Valor de um filtro `.eq(coluna, valor)` registrado na chamada. */
function eq(chamada, coluna) {
  const op = chamada.ops.find(([nome, args]) => nome === 'eq' && args[0] === coluna)
  return op ? op[1][1] : undefined
}
const consultas = (tabela) => mockDb.chamadas.filter((c) => c.tabela === tabela)
const temOp = (chamada, nome) => chamada.ops.some(([n]) => n === nome)

function zerar() {
  mockDb.chamadas = []
  mockDb.responder = () => ({ data: null, error: null })
}

const response = () => {
  const res = { set: jest.fn() }
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

beforeEach(() => {
  zerar()
  modoSimples.invalidateEmpresaModoSimplesCache()
  financeiro.invalidateFinanceiroSetorCache()
  alerta.invalidateAlertaSemRespostaCache()
  colaboradores.invalidateColaboradoresEncaminharCache()
})

// ---------------------------------------------------------------------------------------------
// 1. empresaModoSimplesAtivo
// ---------------------------------------------------------------------------------------------
describe('empresaModoSimplesAtivo (empresas.atendimento_modo_simples)', () => {
  const flagsPorEmpresa = { 1: true, 2: false }
  const responderFlags = (c) => (c.tabela === 'empresas'
    ? { data: { atendimento_modo_simples: flagsPorEmpresa[eq(c, 'id')] }, error: null }
    : { data: null, error: null })

  test('(a) 2ª chamada da mesma empresa sai do cache', async () => {
    mockDb.responder = responderFlags
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    expect(consultas('empresas')).toHaveLength(1)
  })

  test('(b) empresas diferentes não partilham a entrada', async () => {
    mockDb.responder = responderFlags
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    expect(await modoSimples.empresaModoSimplesAtivo(2)).toBe(false)
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    const qs = consultas('empresas')
    expect(qs).toHaveLength(2)
    expect(qs.map((c) => eq(c, 'id'))).toEqual([1, 2])
  })

  test('(c) erro do banco propaga e NÃO fica cacheado; coluna ausente vira false sem cachear', async () => {
    mockDb.responder = () => ({ data: null, error: { message: 'timeout' } })
    await expect(modoSimples.empresaModoSimplesAtivo(1)).rejects.toBeTruthy()
    mockDb.responder = () => ({ data: null, error: { message: 'column empresas.atendimento_modo_simples does not exist' } })
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(false)
    mockDb.responder = responderFlags
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    expect(consultas('empresas')).toHaveLength(3)
  })

  test('(d) PUT /config/empresa invalida a flag da empresa que salvou — e só dela', async () => {
    const { putEmpresa } = require('../controllers/configController')
    mockDb.responder = responderFlags
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(true)
    expect(await modoSimples.empresaModoSimplesAtivo(2)).toBe(false)

    // Admin da empresa 1 desliga o modo simples.
    flagsPorEmpresa[1] = false
    mockDb.responder = (c) => {
      if (c.tabela === 'empresas' && temOp(c, 'update')) return { data: { id: eq(c, 'id'), atendimento_modo_simples: false }, error: null }
      return responderFlags(c)
    }
    const res = response()
    await putEmpresa({ user: { company_id: 1, perfil: 'admin' }, body: { atendimento_modo_simples: false } }, res)
    expect(res.status).not.toHaveBeenCalledWith(500)
    expect(res.status).not.toHaveBeenCalledWith(400)

    zerar(); mockDb.responder = responderFlags
    expect(await modoSimples.empresaModoSimplesAtivo(1)).toBe(false) // releu
    expect(await modoSimples.empresaModoSimplesAtivo(2)).toBe(false) // continuou no cache
    expect(consultas('empresas').map((c) => eq(c, 'id'))).toEqual([1])
    flagsPorEmpresa[1] = true
  })
})

// ---------------------------------------------------------------------------------------------
// 2. obterDepartamentoIdsFinanceiro
// ---------------------------------------------------------------------------------------------
describe('obterDepartamentoIdsFinanceiro (departamentos da empresa)', () => {
  const depsPorEmpresa = {
    1: [{ id: 10, nome: 'Comercial' }, { id: 11, nome: 'Financeiro' }],
    2: [{ id: 20, nome: 'FINANCEIRO ' }, { id: 21, nome: 'Suporte' }],
  }
  const responderDeps = (c) => (c.tabela === 'departamentos'
    ? { data: depsPorEmpresa[eq(c, 'company_id')] || [], error: null }
    : { data: null, error: null })

  test('(a) 2ª chamada da mesma empresa sai do cache e devolve cópia', async () => {
    mockDb.responder = responderDeps
    const a = await financeiro.obterDepartamentoIdsFinanceiro(1)
    a.push(999)
    const b = await financeiro.obterDepartamentoIdsFinanceiro(1)
    expect(b).toEqual([11])
    expect(consultas('departamentos')).toHaveLength(1)
  })

  test('(b) empresas diferentes não partilham a entrada', async () => {
    mockDb.responder = responderDeps
    expect(await financeiro.obterDepartamentoIdsFinanceiro(1)).toEqual([11])
    expect(await financeiro.obterDepartamentoIdsFinanceiro(2)).toEqual([20])
    expect(await financeiro.obterDepartamentoIdsFinanceiro(1)).toEqual([11])
    expect(consultas('departamentos').map((c) => eq(c, 'company_id'))).toEqual([1, 2])
  })

  test('(c) falha do banco devolve [] e NÃO fica cacheada', async () => {
    mockDb.responder = () => ({ data: null, error: { message: 'timeout' } })
    expect(await financeiro.obterDepartamentoIdsFinanceiro(1)).toEqual([])
    mockDb.responder = responderDeps
    expect(await financeiro.obterDepartamentoIdsFinanceiro(1)).toEqual([11])
    expect(consultas('departamentos')).toHaveLength(2)
  })

  test('(d) criar / renomear / excluir departamento invalidam a empresa do admin — e só ela', async () => {
    const dash = require('../controllers/dashboard/departamentos')
    const mutadores = [
      ['criarDepartamento', { user: { company_id: 1 }, body: { nome: 'Financeiro 2' }, params: {} }],
      ['atualizarDepartamento', { user: { company_id: 1 }, body: { nome: 'Financeiro' }, params: { id: '10' } }],
      ['excluirDepartamento', { user: { company_id: 1 }, body: {}, params: { id: '11' } }],
    ]
    for (const [nome, req] of mutadores) {
      zerar(); financeiro.invalidateFinanceiroSetorCache()
      mockDb.responder = responderDeps
      await financeiro.obterDepartamentoIdsFinanceiro(1)
      await financeiro.obterDepartamentoIdsFinanceiro(2)

      mockDb.responder = (c) => {
        if (c.tabela === 'departamentos' && (temOp(c, 'insert') || temOp(c, 'update'))) return { data: { id: 12, nome: req.body.nome }, error: null }
        if (c.tabela === 'departamentos' && temOp(c, 'delete')) return { data: null, error: null }
        if (c.tabela !== 'departamentos') return { data: [], error: null } // usuarios/conversas/… vinculados: nenhum
        return responderDeps(c)
      }
      const res = response()
      await dash[nome](req, res)
      expect(res.status).not.toHaveBeenCalledWith(500)

      zerar(); mockDb.responder = responderDeps
      await financeiro.obterDepartamentoIdsFinanceiro(1)
      await financeiro.obterDepartamentoIdsFinanceiro(2)
      expect(consultas('departamentos').map((c) => eq(c, 'company_id'))).toEqual([1]) // só a 1 releu
    }
  })

  test('(d) departamentos padrão criados pelo auto-config do chatbot (um é "Financeiro") invalidam', async () => {
    const { generateChatbotConfig } = require('../services/chatbotAutoConfigService')
    mockDb.responder = responderDeps
    await financeiro.obterDepartamentoIdsFinanceiro(3) // empresa nova: [] cacheado

    let proximoId = 30
    mockDb.responder = (c) => {
      if (c.tabela === 'empresas') return { data: { id: 3, nome: 'Nova', ativo: true }, error: null }
      if (c.tabela === 'departamentos' && temOp(c, 'insert')) {
        const nome = c.ops.find(([n]) => n === 'insert')[1][0].nome
        return { data: { id: proximoId++, nome }, error: null }
      }
      return { data: [], error: null }
    }
    await generateChatbotConfig(3)

    zerar()
    mockDb.responder = (c) => ({ data: c.tabela === 'departamentos' ? [{ id: 32, nome: 'Financeiro' }] : [], error: null })
    expect(await financeiro.obterDepartamentoIdsFinanceiro(3)).toEqual([32])
    expect(consultas('departamentos')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. isAlertaSemRespostaAtivo
// ---------------------------------------------------------------------------------------------
describe('isAlertaSemRespostaAtivo (ia_config.config.alerta_sem_resposta)', () => {
  const configPorEmpresa = {
    1: { alerta_sem_resposta: { alerta_sem_resposta_ativo: true } },
    2: { alerta_sem_resposta: { ativo: 'false' } },
  }
  const responderCfg = (c) => (c.tabela === 'ia_config'
    ? { data: { config: configPorEmpresa[eq(c, 'company_id')] || {} }, error: null }
    : { data: null, error: null })

  test('(a) 2ª chamada da mesma empresa sai do cache', async () => {
    mockDb.responder = responderCfg
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(consultas('ia_config')).toHaveLength(1)
  })

  test('(b) empresas diferentes não partilham a entrada', async () => {
    mockDb.responder = responderCfg
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(await alerta.isAlertaSemRespostaAtivo(2)).toBe(false)
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(consultas('ia_config').map((c) => eq(c, 'company_id'))).toEqual([1, 2])
  })

  test('(c) falha do banco devolve false e NÃO fica cacheada', async () => {
    mockDb.responder = () => ({ data: null, error: { message: 'timeout' } })
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(false)
    mockDb.responder = () => { throw new Error('rede caiu') }
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(false)
    mockDb.responder = responderCfg
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(consultas('ia_config')).toHaveLength(3)
  })

  test('(d) salvar a config do alerta invalida a empresa — e só ela', async () => {
    const { saveAlertaSemRespostaConfig } = require('../services/atendimentoSemResposta/config')
    mockDb.responder = responderCfg
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(true)
    expect(await alerta.isAlertaSemRespostaAtivo(2)).toBe(false)

    configPorEmpresa[1] = { alerta_sem_resposta: { alerta_sem_resposta_ativo: false } }
    mockDb.responder = (c) => {
      if (c.tabela === 'ia_config' && temOp(c, 'upsert')) return { data: null, error: null }
      if (c.tabela !== 'ia_config') return { data: [], error: null }
      return responderCfg(c)
    }
    const r = await saveAlertaSemRespostaConfig(1, { alerta_sem_resposta_ativo: false })
    expect(r.ok).toBe(true)

    zerar(); mockDb.responder = responderCfg
    expect(await alerta.isAlertaSemRespostaAtivo(1)).toBe(false)
    expect(await alerta.isAlertaSemRespostaAtivo(2)).toBe(false)
    expect(consultas('ia_config').map((c) => eq(c, 'company_id'))).toEqual([1])
    configPorEmpresa[1] = { alerta_sem_resposta: { alerta_sem_resposta_ativo: true } }
  })

  test('(d) PUT /ia/config e o auto-config do chatbot regravam `config` inteiro: também invalidam', async () => {
    const { putConfig } = require('../controllers/iaController')
    const { toggleChatbotForCompany } = require('../services/chatbotAutoConfigService')
    const responderUpsert = (c) => {
      if (c.tabela === 'ia_config' && temOp(c, 'upsert')) return { data: { config: {} }, error: null }
      if (c.tabela !== 'ia_config') return { data: [], error: null }
      return responderCfg(c)
    }

    mockDb.responder = responderCfg
    await alerta.isAlertaSemRespostaAtivo(1)
    mockDb.responder = responderUpsert
    const res = response()
    await putConfig({ user: { company_id: 1 }, body: { bot_global: {} } }, res)
    expect(res.status).not.toHaveBeenCalledWith(500)
    zerar(); mockDb.responder = responderCfg
    await alerta.isAlertaSemRespostaAtivo(1)
    expect(consultas('ia_config')).toHaveLength(1)

    mockDb.responder = responderUpsert
    expect(await toggleChatbotForCompany(1, true)).toBe(true)
    zerar(); mockDb.responder = responderCfg
    await alerta.isAlertaSemRespostaAtivo(1)
    expect(consultas('ia_config')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
// 4. listarColaboradoresEncaminhar
// ---------------------------------------------------------------------------------------------
describe('listarColaboradoresEncaminhar (usuarios ativos da empresa)', () => {
  const usuariosPorEmpresa = {
    1: [
      { id: 7, nome: 'Ana', email: 'ana@x', perfil: 'atendente' },
      { id: 2, nome: 'Bia', email: null, perfil: 'admin' },
      { id: 9, nome: 'Caio', email: 'caio@x', perfil: 'atendente' },
    ],
    2: [{ id: 50, nome: 'Zé', email: 'ze@y', perfil: 'admin' }],
  }
  const responderUsers = (c) => (c.tabela === 'usuarios'
    ? { data: usuariosPorEmpresa[eq(c, 'company_id')] || [], error: null }
    : { data: null, error: null })

  test('(e) formato e ordem de antes; o chamador fica de fora (neq em memória); a consulta lê só ativos', async () => {
    mockDb.responder = responderUsers
    const lista = await colaboradores.listarColaboradoresEncaminhar(1, 2)
    expect(lista).toEqual([
      { usuario_id: 7, nome: 'Ana', email: 'ana@x', perfil: 'atendente' },
      { usuario_id: 9, nome: 'Caio', email: 'caio@x', perfil: 'atendente' },
    ])
    const [q] = consultas('usuarios')
    expect(eq(q, 'company_id')).toBe(1)
    expect(eq(q, 'ativo')).toBe(true)
    expect(temOp(q, 'order')).toBe(true)
    expect(temOp(q, 'neq')).toBe(false) // a lista completa vai ao cache
  })

  test('(a) dois usuários da mesma empresa partilham UMA consulta e cada um recebe a sua lista (cópias)', async () => {
    mockDb.responder = responderUsers
    const deBia = await colaboradores.listarColaboradoresEncaminhar(1, 2)
    expect(deBia[0].usuario_id).toBe(7) // Ana
    deBia[0].nome = 'mutado'
    const deAna = await colaboradores.listarColaboradoresEncaminhar(1, 7)
    expect(deAna.map((u) => u.usuario_id)).toEqual([2, 9])
    const deCaio = await colaboradores.listarColaboradoresEncaminhar(1, 9)
    expect(deCaio.find((u) => u.usuario_id === 7).nome).toBe('Ana') // a mutação de Bia não vazou para o cache
    expect(consultas('usuarios')).toHaveLength(1)
  })

  test('(b) empresas diferentes não partilham a entrada', async () => {
    mockDb.responder = responderUsers
    expect((await colaboradores.listarColaboradoresEncaminhar(1, 2)).map((u) => u.usuario_id)).toEqual([7, 9])
    expect((await colaboradores.listarColaboradoresEncaminhar(2, 2)).map((u) => u.usuario_id)).toEqual([50])
    expect((await colaboradores.listarColaboradoresEncaminhar(1, 7)).map((u) => u.usuario_id)).toEqual([2, 9])
    expect(consultas('usuarios').map((c) => eq(c, 'company_id'))).toEqual([1, 2])
  })

  test('(c) falha do banco devolve [] e NÃO fica cacheada', async () => {
    mockDb.responder = () => ({ data: null, error: { message: 'timeout' } })
    expect(await colaboradores.listarColaboradoresEncaminhar(1, 2)).toEqual([])
    mockDb.responder = responderUsers
    expect(await colaboradores.listarColaboradoresEncaminhar(1, 2)).toHaveLength(2)
    expect(consultas('usuarios')).toHaveLength(2)
  })

  test('(d) criar / atualizar / desativar usuário invalidam a empresa do admin — e só ela', async () => {
    const userController = require('../controllers/userController')
    const mutadores = [
      ['criar', { user: { company_id: 1 }, params: {}, body: { nome: 'Dani', email: 'dani@x', senha: 'segredo1', perfil: 'atendente' } }],
      ['atualizar', { user: { company_id: 1 }, params: { id: '7' }, body: { nome: 'Ana Paula' } }],
      ['excluir', { user: { company_id: 1 }, params: { id: '9' }, body: {} }],
    ]
    for (const [nome, req] of mutadores) {
      zerar(); colaboradores.invalidateColaboradoresEncaminharCache()
      mockDb.responder = responderUsers
      await colaboradores.listarColaboradoresEncaminhar(1, 2)
      await colaboradores.listarColaboradoresEncaminhar(2, 50)

      mockDb.responder = (c) => {
        if (c.tabela === 'usuarios' && (temOp(c, 'insert') || temOp(c, 'update'))) {
          return { data: { id: 77, nome: req.body.nome || 'x', email: 'e', perfil: 'atendente', ativo: true, departamento_id: null }, error: null }
        }
        if (c.tabela === 'usuarios' && temOp(c, 'single')) return { data: { id: Number(req.params.id) }, error: null }
        return { data: [], error: null }
      }
      const res = response()
      await userController[nome](req, res)
      expect(res.status).not.toHaveBeenCalledWith(500)
      expect(res.status).not.toHaveBeenCalledWith(404)

      zerar(); mockDb.responder = responderUsers
      await colaboradores.listarColaboradoresEncaminhar(1, 2)
      await colaboradores.listarColaboradoresEncaminhar(2, 50)
      expect(consultas('usuarios').map((c) => eq(c, 'company_id'))).toEqual([1])
    }
  })
})
