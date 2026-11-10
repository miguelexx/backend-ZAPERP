/**
 * `POST /orcamentos/vendedores/consultar` — os vendedores do ERP, antes de o orçamento existir.
 *
 * POR QUE ESTA ROTA EXISTE: até 09/11/2026 o vendedor era o único dos três campos sem porta
 * própria. Cliente tinha `/clientes/consultar`, produto tinha `/produtos/consultar`, e vendedor
 * só se resolvia dentro de `preparar` — que exige cliente E ao menos um item. O atendente novo
 * tinha de adivinhar como o nome dele está cadastrado no ERP. Pedido 2 do item D do Anexo A,
 * atendido.
 *
 * ESTES TESTES EXISTEM PORQUE O CONTRATO DESTA PORTA **NÃO É** O DE CLIENTES. Três diferenças,
 * medidas ao vivo em 09/11/2026, e quem copiar o padrão de clientes erra nas três:
 *
 *   1. a lista vem em `dados.vendedores[]` e **não existe campo `status`**;
 *   2. nada encontrado é **`200` com `vendedores: []` e `total: 0`**, nunca 404;
 *   3. **`busca` é OPCIONAL** — sem ela, a WM devolve TODOS os vendedores.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *   1. **isolamento entre empresas** — o telefone é o único seletor de tenant do lado da WM
 *      (pendência 13), então empresa A nunca pode ver vendedor da empresa B, nem pelo cache;
 *   2. a rota está montada e **fechada** pela flag — 403, não 404;
 *   3. **lista vazia nunca vira erro**, e `503 SINCRONIZADOR_OFFLINE` nunca vira lista vazia;
 *   4. `busca` vazia **nunca** chega à WM (ela responde `400 payload_invalido`);
 *   5. identidade no body (`telefone`, `company_id`, `token`) é recusada;
 *   6. o telefone autorizado não aparece na resposta.
 *
 * Nenhum teste faz rede real: `wmApiClient` é mock e `global.fetch` falha se chamado.
 */
const request = require('supertest')
const jwt = require('jsonwebtoken')

jest.mock('../services/wm/wmApiClient', () => ({
  consultarProdutos: jest.fn(),
  consultarClientes: jest.fn(),
  consultarVendedores: jest.fn(),
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
const { validarConsultarVendedoresBody } = require('../validators/wmOrcamentosValidators')

const ROTA = '/orcamentos/vendedores/consultar'
const ROTA_API = '/api/orcamentos/vendedores/consultar'

const TELEFONE_EMPRESA_1 = '5517981881417'
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

/**
 * A forma MEDIDA da resposta: `dados.vendedores[]`, sem `status`, com `paginacao` completa.
 * Reproduzi-la aqui é o que faz estes testes valerem como contrato.
 */
function respostaVendedores(marcador, { total = 1 } = {}) {
  return {
    ok: true,
    status: 200,
    operacao: 'leitura',
    data: {
      dados: {
        vendedores: total === 0
          ? []
          : [{ codigo_vendedor_erp: marcador, nome: `VENDEDOR ${marcador}` }],
        paginacao: { pagina: 1, tamanho_pagina: 30, total, tem_mais: false, tem_anterior: false },
      },
      meta: { fonte: 'tempo_real', consultado_em: '2026-11-09T12:00:00.000Z' },
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
      1: { telefone: TELEFONE_EMPRESA_1, versao: '2026-11-09T12:00:00.000Z' },
      2: { telefone: TELEFONE_EMPRESA_2, versao: '2026-11-09T12:30:00.000Z' },
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
  wmApiClient.consultarVendedores.mockResolvedValue(respostaVendedores('003'))
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
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(wmApiClient.consultarVendedores).not.toHaveBeenCalled()
  })

  it('sem token não passa do auth', async () => {
    const res = await request(app).post(ROTA).send({})
    expect(res.status).toBe(401)
    expect(wmApiClient.consultarVendedores).not.toHaveBeenCalled()
  })
})

/* ================================================================== *
 * 2. Isolamento entre empresas — o ponto crítico
 * ================================================================== */

describe('empresa A não obtém nada da empresa B', () => {
  beforeEach(() => {
    ligarModulo()
    wmApiClient.consultarVendedores.mockImplementation(async (payload) =>
      respostaVendedores(payload.telefone === TELEFONE_EMPRESA_1 ? 'EMPRESA-1' : 'EMPRESA-2')
    )
  })

  it('a mesma consulta em empresas diferentes devolve vendedores diferentes, e o cache não vaza', async () => {
    const r1 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'mark' })
    const r2 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ id: 77, company_id: 2 })}`).send({ busca: 'mark' })
    const r1DeNovo = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'mark' })

    expect(r1.body.vendedores[0].codigo_vendedor_erp).toBe('EMPRESA-1')
    expect(r2.body.vendedores[0].codigo_vendedor_erp).toBe('EMPRESA-2')
    expect(JSON.stringify(r1.body)).not.toContain('EMPRESA-2')
    expect(JSON.stringify(r2.body)).not.toContain('EMPRESA-1')

    // 3ª requisição: veio do cache da empresa 1, com o conteúdo da 1.
    expect(r1DeNovo.body.vendedores[0].codigo_vendedor_erp).toBe('EMPRESA-1')
    expect(wmApiClient.consultarVendedores).toHaveBeenCalledTimes(2)
  })

  it('o modo "todos" (corpo vazio) também é isolado por empresa no cache', async () => {
    // O caso mais comum da tela: abrir o campo. Se o cache do modo `todos` não carregasse o
    // tenant, a lista inteira de vendedores de uma loja apareceria na outra.
    const r1 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({})
    const r2 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ id: 77, company_id: 2 })}`).send({})

    expect(r1.body.vendedores[0].codigo_vendedor_erp).toBe('EMPRESA-1')
    expect(r2.body.vendedores[0].codigo_vendedor_erp).toBe('EMPRESA-2')
    expect(wmApiClient.consultarVendedores).toHaveBeenCalledTimes(2)
  })

  it('o telefone enviado à WM é o da empresa do JWT, nunca o do body', async () => {
    await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 2 })}`)
      .send({ busca: 'mark' })

    expect(configService.obterConfigInterna).toHaveBeenCalledWith(2)
    expect(wmApiClient.consultarVendedores.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_2)
  })

  it('empresa sem vínculo não vê nada e não chega à WM', async () => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 3 })}`)
      .send({})

    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_INTEGRACAO_NAO_CONFIGURADA')
    expect(wmApiClient.consultarVendedores).not.toHaveBeenCalled()
  })

  it('a chave do cache não se mistura com a de clientes nem com a de produtos', () => {
    // Endpoints distintos na chave: o MESMO termo nas três portas são três entradas.
    expect(servico.ENDPOINT_VENDEDORES).toBe('vendedores/consultar')
    expect(servico.ENDPOINT_VENDEDORES).not.toBe(servico.ENDPOINT_CLIENTES)
    expect(servico.ENDPOINT_VENDEDORES).not.toBe(servico.ENDPOINT_PRODUTOS)

    const base = { companyId: 1, configVersao: 'v1', modo: 'busca', termo: 'mark', pagina: 1 }
    const chaveV = cache.montarChave({ ...base, endpoint: servico.ENDPOINT_VENDEDORES })
    const chaveC = cache.montarChave({ ...base, endpoint: servico.ENDPOINT_CLIENTES })
    const chaveP = cache.montarChave({ ...base, endpoint: servico.ENDPOINT_PRODUTOS })
    expect(new Set([chaveV, chaveC, chaveP]).size).toBe(3)
  })
})

/* ================================================================== *
 * 3. Corpo aceito — e a diferença 3: `busca` é OPCIONAL
 * ================================================================== */

describe('corpo da requisição', () => {
  beforeEach(ligarModulo)

  it('CORPO VAZIO é válido e pede TODOS os vendedores — sem chave de termo no payload', async () => {
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(200)
    const payload = wmApiClient.consultarVendedores.mock.calls[0][0]
    // A diferença que mais importa: `busca` AUSENTE, não vazia. `busca: ""` é 400 na WM.
    expect(payload).not.toHaveProperty('busca')
    expect(payload).not.toHaveProperty('codigo_vendedor_erp')
    expect(Object.keys(payload)).toEqual(['telefone'])
  })

  it('nunca envia `busca` vazia à WM: ela é recusada localmente', async () => {
    for (const corpo of [{ busca: '' }, { busca: '   ' }]) {
      const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send(corpo)
      expect(res.status).toBe(400)
    }
    expect(wmApiClient.consultarVendedores).not.toHaveBeenCalled()
  })

  it('recusa identidade no body', async () => {
    for (const corpo of [
      { busca: 'mark', telefone: '5511999999999' },
      { busca: 'mark', company_id: 2 },
      { busca: 'mark', token: 'x' },
    ]) {
      const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send(corpo)
      expect(res.status).toBe(400)
    }
    expect(wmApiClient.consultarVendedores).not.toHaveBeenCalled()
  })

  it('aceita nenhum, busca OU código — mas nunca os dois (ao contrário de clientes, que exige um)', () => {
    expect(validarConsultarVendedoresBody({}).ok).toBe(true)
    expect(validarConsultarVendedoresBody(undefined).ok).toBe(true)
    expect(validarConsultarVendedoresBody({ busca: 'mark' }).ok).toBe(true)
    expect(validarConsultarVendedoresBody({ codigo_vendedor_erp: '003' }).ok).toBe(true)
    expect(validarConsultarVendedoresBody({ busca: 'mark', codigo_vendedor_erp: '003' }).ok).toBe(false)
  })

  it('código de vendedor aceita os 20 caracteres do contrato', () => {
    expect(validarConsultarVendedoresBody({ codigo_vendedor_erp: 'A'.repeat(20) }).ok).toBe(true)
    expect(validarConsultarVendedoresBody({ codigo_vendedor_erp: 'A'.repeat(21) }).ok).toBe(false)
  })

  it('página fora do intervalo é recusada localmente; válida passa sem clamp', () => {
    expect(validarConsultarVendedoresBody({ pagina: 0 }).ok).toBe(false)
    expect(validarConsultarVendedoresBody({ pagina: 1.5 }).ok).toBe(false)
    expect(validarConsultarVendedoresBody({ pagina: 2 }).value.pagina).toBe(2)
  })

  it('apara as bordas do termo — a busca casa TRECHO, e espaço colado numa ponta não casa', async () => {
    await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: '  arkony  ' })
    expect(wmApiClient.consultarVendedores.mock.calls[0][0].busca).toBe('arkony')
  })

  it('código exato chega como `codigo_vendedor_erp`, não como busca', async () => {
    await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ codigo_vendedor_erp: '003' })
    const payload = wmApiClient.consultarVendedores.mock.calls[0][0]
    expect(payload.codigo_vendedor_erp).toBe('003')
    expect(payload).not.toHaveProperty('busca')
  })
})

/* ================================================================== *
 * 4. A resposta — vazio ≠ erro, e indisponibilidade ≠ vazio
 * ================================================================== */

describe('resposta ao navegador', () => {
  beforeEach(ligarModulo)

  it('LISTA VAZIA é 200 com `vendedores: []` — nunca erro, nunca 404', async () => {
    // O ponto desta porta: "não há vendedor com esse nome" e "não foi possível buscar agora"
    // são conclusões opostas para quem está com o cliente esperando.
    wmApiClient.consultarVendedores.mockResolvedValue(respostaVendedores('x', { total: 0 }))

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'zzzz' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.vendedores).toEqual([])
    expect(res.body.paginacao.total).toBe(0)
    expect(res.body.codigo).toBeUndefined()
  })

  it('503 SINCRONIZADOR_OFFLINE chega como indisponibilidade, não como lista vazia', async () => {
    // Esta porta é realtime: cai junto com o sincronizador da loja. Lista vazia faria o
    // atendente concluir que o vendedor não está cadastrado.
    wmApiClient.consultarVendedores.mockResolvedValue({
      ok: false, status: 503, erroWm: 'SINCRONIZADOR_OFFLINE', transporte: null, data: { erro: 'SINCRONIZADOR_OFFLINE' },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_SINCRONIZADOR_OFFLINE')
    expect(res.body.vendedores).toBeUndefined()
  })

  it('400 PAGINA_FORA_DO_INTERVALO atravessa sem clamp e sem virar lista vazia', async () => {
    wmApiClient.consultarVendedores.mockResolvedValue({
      ok: false, status: 400, erroWm: 'PAGINA_FORA_DO_INTERVALO', transporte: null, data: { erro: 'PAGINA_FORA_DO_INTERVALO' },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ pagina: 99 })

    expect(res.status).toBe(400)
    expect(res.body.codigo).toBe('WM_PAGINA_FORA_DO_INTERVALO')
    expect(res.body.vendedores).toBeUndefined()
    // Sem clamp: a página pedida foi a que viajou.
    expect(wmApiClient.consultarVendedores.mock.calls[0][0].pagina).toBe(99)
  })

  it('carrega resolucao_definitiva: false — quem resolve o vendedor é o Calcular (D11)', async () => {
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({})
    expect(res.body.resolucao_definitiva).toBe(false)
  })

  it('o telefone autorizado nunca aparece na resposta', async () => {
    wmApiClient.consultarVendedores.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: respostaVendedores('003').data.dados,
        // A WM não deveria devolver isto; se devolver, não pode atravessar.
        meta: { fonte: 'tempo_real', telefone: TELEFONE_EMPRESA_1 },
      },
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({})
    expect(JSON.stringify(res.body)).not.toContain(TELEFONE_EMPRESA_1)
  })

  it('a lista chega com código e nome, e nada além disso', async () => {
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({})
    expect(res.body.vendedores[0]).toEqual({ codigo_vendedor_erp: '003', nome: 'VENDEDOR 003' })
  })
})

/* ================================================================== *
 * 5. Projeções puras — as três diferenças, isoladas
 * ================================================================== */

describe('projeções', () => {
  it('vendedor sem código ou sem nome não é selecionável', () => {
    expect(servico.projetarVendedor({ codigo_vendedor_erp: '003', nome: 'MARKONY' })).not.toBeNull()
    expect(servico.projetarVendedor({ codigo_vendedor_erp: '', nome: 'MARKONY' })).toBeNull()
    expect(servico.projetarVendedor({ codigo_vendedor_erp: '003', nome: '   ' })).toBeNull()
    expect(servico.projetarVendedor(null)).toBeNull()
  })

  it('campo fora da lista branca não atravessa', () => {
    const v = servico.projetarVendedor({
      codigo_vendedor_erp: '003',
      nome: 'MARKONY',
      comissao_percentual: '3.5',
      telefone: '5511999999999',
    })
    expect(Object.keys(v).sort()).toEqual(['codigo_vendedor_erp', 'nome'])
  })

  it('AUSÊNCIA de `status` é o contrato: a resposta vale sem ele', () => {
    // Clientes têm `status`; vendedores não. Exigir `status` aqui faria toda resposta legítima
    // virar `respostaInvalida` — é o erro de quem copia a projeção de clientes.
    const r = servico.projetarRespostaVendedores({
      dados: {
        vendedores: [{ codigo_vendedor_erp: '002', nome: 'SAMUEL' }],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 1, tem_mais: false, tem_anterior: false },
      },
    }, TELEFONE_EMPRESA_1)

    expect(r.ok).toBe(true)
    expect(r.dados.vendedores).toHaveLength(1)
  })

  it('LISTA VAZIA é sucesso, não `respostaInvalida`', () => {
    const r = servico.projetarRespostaVendedores({
      dados: {
        vendedores: [],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 0, tem_mais: false, tem_anterior: false },
      },
    }, TELEFONE_EMPRESA_1)

    expect(r.ok).toBe(true)
    expect(r.dados.vendedores).toEqual([])
    expect(r.respostaInvalida).toBeUndefined()
  })

  it('FORMA fora do contrato continua sendo resposta inválida', () => {
    // A distinção que o vazio não pode apagar: ausência de dado × resposta que não é a do contrato.
    expect(servico.projetarRespostaVendedores({ dados: {} }, '').ok).toBe(false)
    expect(servico.projetarRespostaVendedores({ dados: { vendedores: 'nenhum' } }, '').ok).toBe(false)
    expect(servico.projetarRespostaVendedores({}, '').ok).toBe(false)
    expect(servico.projetarRespostaVendedores(null, '').ok).toBe(false)
  })

  it('um candidato inválido recusa a resposta inteira, em vez de deixar buraco na lista', () => {
    const r = servico.projetarRespostaVendedores({
      dados: {
        vendedores: [{ codigo_vendedor_erp: '003', nome: 'MARKONY' }, { nome: 'SEM CODIGO' }],
      },
    }, TELEFONE_EMPRESA_1)
    expect(r.ok).toBe(false)
    expect(r.respostaInvalida).toBe(true)
  })

  it('paginacao fora do formato não quebra a lista — vira null', () => {
    const r = servico.projetarRespostaVendedores({
      dados: { vendedores: [{ codigo_vendedor_erp: '003', nome: 'MARKONY' }], paginacao: { pagina: 1 } },
    }, TELEFONE_EMPRESA_1)
    expect(r.ok).toBe(true)
    expect(r.dados.paginacao).toBeNull()
  })
})
