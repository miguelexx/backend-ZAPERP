/**
 * `POST /orcamentos/clientes/consultar` — auxílio para achar o cliente no ERP.
 *
 * POR QUE ESTA ROTA EXISTE: a busca de cliente do ERP é **por prefixo**
 * (`dbo.Clientes`, `Latin1_General_CI_AI`, `docs/wm/04-contratos-api.md`). Medido contra a base
 * real: `DINIZ` → nenhum cliente, `SILVA` → nenhum, `MARIA APARECIDA AMADEI` → 3 candidatos.
 * Sem esta consulta, descobrir o nome canônico só era possível errando no Calcular.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *   1. **isolamento entre empresas** — o telefone é o único seletor de tenant do lado da WM
 *      (pendência 13), então empresa A nunca pode ver cliente da empresa B, nem pelo cache;
 *   2. a rota está montada e **fechada** pela flag — 403, não 404;
 *   3. a resposta carrega `resolucao_definitiva: false`: esta rota NÃO decide o cliente do
 *      orçamento, porque não aplica Inativo/Bloqueado e `preparar` aplica (D11);
 *   4. identidade no body (`telefone`, `company_id`, `token`) é recusada;
 *   5. CPF/CNPJ/IE chegam à tela — sem eles dois homônimos são indistinguíveis.
 *
 * Nenhum teste faz rede real: `wmApiClient` é mock e `global.fetch` falha se chamado.
 */
const request = require('supertest')
const jwt = require('jsonwebtoken')

jest.mock('../services/wm/wmApiClient', () => ({
  consultarProdutos: jest.fn(),
  consultarClientes: jest.fn(),
  prepararOrcamento: jest.fn(),
  criarOrcamento: jest.fn(),
}))
jest.mock('../services/wm/wmIntegrationConfigService', () => ({
  obterConfigInterna: jest.fn(),
}))
jest.mock('../helpers/permissoesService', () => ({
  usuarioTemPermissao: jest.fn(),
}))
jest.mock('../services/chat/access/conversationPolicy', () => ({
  assertPermissaoConversa: jest.fn(),
  podeAssumirConversaPorPerfil: jest.fn(),
  assertPodeEnviarMensagem: jest.fn(),
}))

const wmApiClient = require('../services/wm/wmApiClient')
const configService = require('../services/wm/wmIntegrationConfigService')
const { usuarioTemPermissao } = require('../helpers/permissoesService')
const orcamentoWmFlag = require('../helpers/orcamentoWmFlag')
const cache = require('../services/wm/wmConsultaCache')
const servico = require('../services/wm/wmAssistenteService')
const { validarConsultarClientesBody } = require('../validators/wmOrcamentosValidators')

const ROTA = '/orcamentos/clientes/consultar'
const ROTA_API = '/api/orcamentos/clientes/consultar'

const TELEFONE_EMPRESA_1 = '5534991847800'
const TELEFONE_EMPRESA_2 = '5511988887777'

let app
let fetchEspiao

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
  app = require('../app')
})

function token(payload = {}) {
  return jwt.sign({ id: 20, company_id: 1, perfil: 'atendente', ...payload }, process.env.JWT_SECRET)
}

function respostaClientes(marcador) {
  return {
    ok: true,
    status: 200,
    operacao: 'leitura',
    data: {
      dados: {
        status: 'multiplos_clientes',
        candidatos: [{
          codigo_cliente_erp: marcador,
          nome: `CLIENTE ${marcador}`,
          cpf: '123.456.789-00',
          cnpj: null,
          inscricao_estadual: 'ISENTO',
        }],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 1, tem_mais: false, tem_anterior: false },
      },
      meta: { fonte: 'tempo_real' },
    },
  }
}

function ligarModulo() {
  jest.spyOn(orcamentoWmFlag, 'orcamentoWmHabilitado').mockResolvedValue(true)
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  cache.invalidar()
  delete process.env.WM_ORCAMENTOS_ENABLED
  fetchEspiao = jest.fn(() => { throw new Error('nenhum teste pode fazer rede real') })
  global.fetch = fetchEspiao

  usuarioTemPermissao.mockResolvedValue(true)
  configService.obterConfigInterna.mockImplementation(async (cid) => {
    const mapa = {
      1: { telefone: TELEFONE_EMPRESA_1, versao: '2026-10-20T12:00:00.000Z' },
      2: { telefone: TELEFONE_EMPRESA_2, versao: '2026-10-20T12:30:00.000Z' },
    }
    const encontrado = mapa[Number(cid)]
    if (!encontrado) return null
    return {
      company_id: Number(cid),
      ativo: true,
      telefone_autorizado: encontrado.telefone,
      telefone_ultimos4: encontrado.telefone.slice(-4),
      atualizado_em: encontrado.versao,
    }
  })
  wmApiClient.consultarClientes.mockResolvedValue(respostaClientes('X'))
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

/* ================================================================== *
 * 1. Rota montada e fechada
 * ================================================================== */

describe('rota montada e fechada com a flag desligada', () => {
  it.each([ROTA, ROTA_API])('%s responde 403 de módulo, não 404', async (rota) => {
    const res = await request(app)
      .post(rota)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'maria' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
  })

  it('sem token não passa do auth', async () => {
    const res = await request(app).post(ROTA).send({ busca: 'maria' })
    expect(res.status).toBe(401)
    expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
  })
})

/* ================================================================== *
 * 2. Isolamento entre empresas — o ponto crítico
 * ================================================================== */

describe('empresa A não obtém nada da empresa B', () => {
  beforeEach(() => {
    ligarModulo()
    wmApiClient.consultarClientes.mockImplementation(async (payload) =>
      respostaClientes(payload.telefone === TELEFONE_EMPRESA_1 ? 'EMPRESA-1' : 'EMPRESA-2')
    )
  })

  it('a mesma busca em empresas diferentes devolve clientes diferentes, e o cache não vaza', async () => {
    const r1 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'maria' })
    const r2 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ id: 77, company_id: 2 })}`).send({ busca: 'maria' })
    const r1DeNovo = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'maria' })

    expect(r1.body.candidatos[0].codigo_cliente_erp).toBe('EMPRESA-1')
    expect(r2.body.candidatos[0].codigo_cliente_erp).toBe('EMPRESA-2')
    expect(JSON.stringify(r1.body)).not.toContain('EMPRESA-2')
    expect(JSON.stringify(r2.body)).not.toContain('EMPRESA-1')

    // 3ª requisição: veio do cache da empresa 1, com o conteúdo da 1.
    expect(r1DeNovo.body.candidatos[0].codigo_cliente_erp).toBe('EMPRESA-1')
    expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(2)
  })

  it('o telefone enviado à WM é o da empresa do JWT, nunca o do body', async () => {
    await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 2 })}`)
      .send({ busca: 'maria' })

    expect(configService.obterConfigInterna).toHaveBeenCalledWith(2)
    expect(wmApiClient.consultarClientes.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_2)
  })

  it('empresa sem vínculo não vê nada e não chega à WM', async () => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 3 })}`)
      .send({ busca: 'maria' })

    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_INTEGRACAO_NAO_CONFIGURADA')
    expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
  })
})

/* ================================================================== *
 * 3. Corpo aceito
 * ================================================================== */

describe('corpo da requisição', () => {
  beforeEach(ligarModulo)

  it('recusa identidade no body', async () => {
    for (const corpo of [
      { busca: 'maria', telefone: '5511999999999' },
      { busca: 'maria', company_id: 2 },
      { busca: 'maria', token: 'x' },
    ]) {
      const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send(corpo)
      expect(res.status).toBe(400)
      expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
    }
  })

  it('exige exatamente um entre busca e codigo_cliente_erp', () => {
    expect(validarConsultarClientesBody({ busca: 'maria' }).ok).toBe(true)
    expect(validarConsultarClientesBody({ codigo_cliente_erp: '0000108' }).ok).toBe(true)
    expect(validarConsultarClientesBody({}).ok).toBe(false)
    expect(validarConsultarClientesBody({ busca: 'maria', codigo_cliente_erp: '0000108' }).ok).toBe(false)
  })

  it('código de cliente aceita os 20 caracteres do contrato, não os 7 do produto', () => {
    // `cliente_codigo_erp` é maxLength 20 no `CriarOrcamento`; produto é outra numeração.
    expect(validarConsultarClientesBody({ codigo_cliente_erp: 'A'.repeat(20) }).ok).toBe(true)
    expect(validarConsultarClientesBody({ codigo_cliente_erp: 'A'.repeat(21) }).ok).toBe(false)
  })

  it('página fora do intervalo é recusada localmente', () => {
    expect(validarConsultarClientesBody({ busca: 'maria', pagina: 0 }).ok).toBe(false)
    expect(validarConsultarClientesBody({ busca: 'maria', pagina: 1.5 }).ok).toBe(false)
    expect(validarConsultarClientesBody({ busca: 'maria', pagina: 2 }).ok).toBe(true)
  })

  it('apara as bordas do termo — com prefixo, espaço à esquerda é zero resultado garantido', async () => {
    await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: '  Maria Aparecida  ' })
    // Só as bordas: o miolo e a caixa vão intocados.
    expect(wmApiClient.consultarClientes.mock.calls[0][0].busca).toBe('Maria Aparecida')
  })

  it('a busca de PRODUTO continua sem aparar — lá a semântica é outra', () => {
    const { validarConsultarProdutosBody } = require('../validators/wmOrcamentosValidators')
    // Produto casa trecho e a correspondência exata depende do valor enviado byte a byte.
    expect(validarConsultarProdutosBody({ busca: '  cimento  ' }).value.busca).toBe('  cimento  ')
  })

  it('termo só de espaços é recusado, não vira busca vazia', () => {
    expect(validarConsultarClientesBody({ busca: '   ' }).ok).toBe(false)
  })
})

/* ================================================================== *
 * 4. A resposta não pode virar decisão
 * ================================================================== */

describe('resposta ao navegador', () => {
  beforeEach(ligarModulo)

  it('carrega resolucao_definitiva: false — quem decide o cliente é o Calcular', async () => {
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'maria' })

    expect(res.status).toBe(200)
    // A rota não aplica Inativo/Bloqueado (o `preparar` aplica): a tela tem de saber disso.
    expect(res.body.resolucao_definitiva).toBe(false)
  })

  it('traz CPF, CNPJ e IE — sem eles dois homônimos são indistinguíveis', async () => {
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'maria' })
    const c = res.body.candidatos[0]

    expect(c.cpf).toBe('123.456.789-00')
    expect(c.cnpj).toBeNull()
    expect(c.inscricao_estadual).toBe('ISENTO')
  })

  it('o telefone autorizado nunca aparece na resposta', async () => {
    wmApiClient.consultarClientes.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: respostaClientes('X').data.dados,
        // A WM não deveria devolver isto; se devolver, não pode atravessar.
        meta: { fonte: 'tempo_real', telefone: TELEFONE_EMPRESA_1 },
      },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'maria' })
    expect(JSON.stringify(res.body)).not.toContain(TELEFONE_EMPRESA_1)
  })

  it('cliente único resolvido também responde, com o mesmo aviso', async () => {
    wmApiClient.consultarClientes.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: { status: 'cliente', cliente: { codigo_cliente_erp: '0000108', nome: 'JOAO DA SILVA' } },
        meta: { fonte: 'tempo_real' },
      },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'joao da silva' })

    expect(res.body.status).toBe('cliente')
    expect(res.body.cliente.nome).toBe('JOAO DA SILVA')
    expect(res.body.resolucao_definitiva).toBe(false)
  })

  it('503 SINCRONIZADOR_OFFLINE chega como indisponibilidade, não como lista vazia', async () => {
    // Esta porta é realtime: cai junto com o sincronizador da loja. Lista vazia faria o
    // atendente concluir que o cliente não existe.
    wmApiClient.consultarClientes.mockResolvedValue({
      ok: false, status: 503, erroWm: 'SINCRONIZADOR_OFFLINE', transporte: null, data: { erro: 'SINCRONIZADOR_OFFLINE' },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'maria' })

    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_SINCRONIZADOR_OFFLINE')
    expect(res.body.candidatos).toBeUndefined()
  })
})

/* ================================================================== *
 * 5. Projeções puras
 * ================================================================== */

describe('projeções', () => {
  it('candidato sem código ou sem nome não é selecionável', () => {
    expect(servico.projetarCliente({ codigo_cliente_erp: '1', nome: 'X' })).not.toBeNull()
    expect(servico.projetarCliente({ codigo_cliente_erp: '', nome: 'X' })).toBeNull()
    expect(servico.projetarCliente({ codigo_cliente_erp: '1', nome: '   ' })).toBeNull()
    expect(servico.projetarCliente(null)).toBeNull()
  })

  it('campo fora da lista branca não atravessa', () => {
    const c = servico.projetarCliente({
      codigo_cliente_erp: '1',
      nome: 'X',
      limite_credito: '9999.00',
      telefone: '5511999999999',
    })
    expect(Object.keys(c).sort()).toEqual(['cnpj', 'codigo_cliente_erp', 'cpf', 'inscricao_estadual', 'nome'])
  })

  it('um candidato inválido recusa a resposta inteira, em vez de deixar buraco na lista', () => {
    const r = servico.projetarRespostaClientes({
      dados: {
        status: 'multiplos_clientes',
        candidatos: [{ codigo_cliente_erp: '1', nome: 'OK' }, { nome: 'SEM CODIGO' }],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 2, tem_mais: false, tem_anterior: false },
      },
    }, TELEFONE_EMPRESA_1)
    expect(r.ok).toBe(false)
    expect(r.respostaInvalida).toBe(true)
  })

  it('status desconhecido é resposta inválida, nunca lista vazia', () => {
    expect(servico.projetarRespostaClientes({ dados: { status: 'outra_coisa' } }, '').ok).toBe(false)
    expect(servico.projetarRespostaClientes({}, '').ok).toBe(false)
    expect(servico.projetarRespostaClientes(null, '').ok).toBe(false)
  })
})
