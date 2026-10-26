/**
 * Preparação do orçamento WM — Sessão 4A do doc 36.
 *
 * Prova as três coisas que a preparação tem de garantir antes de existir qualquer gravação
 * no ERP:
 *
 *   1. **O laço de ambiguidade devolve o rascunho inteiro** e nunca escolhe candidato — nem
 *      quando a última página traz um só registro com `total > 1` (o contrato é explícito).
 *      Paginar troca apenas a lista de candidatos; `indice_item` é zero-based e sobrevive à
 *      ida e à volta. Página além da última é 400 `PAGINA_FORA_DO_INTERVALO`, sem clamp.
 *   2. **O snapshot é server-side.** Em `pronto_para_confirmacao` o payload exato de `criar`
 *      vai para `payload_criacao` + `payload_hash`, e a UI recebe só um `preparacao_id` opaco
 *      e a prévia sanitizada. O preço é copiado BYTE A BYTE (`33.038`, `1200.500`) e preço que
 *      não venha como string decimal é RECUSADO — nunca convertido.
 *   3. **Isolamento.** `company_id` só por argumento (que vem do JWT), toda query filtrada, o
 *      telefone autorizado resolvido no servidor e ausente do snapshot, da resposta e do log.
 *
 * A extração prévia → payload usa o shape REAL documentado pela WM na 2ª remessa do contrato
 * (§8, §8.1 e §9.2 do guia de 20/10/2026), em `tests/fixtures/wmPreviaReal.js` — a fixture
 * provisória da 4A não existe mais.
 *
 * Nenhum teste faz rede real: `wmApiClient` é mock e `global.fetch` falha se chamado.
 */
const fs = require('fs')
const path = require('path')
const request = require('supertest')
const jwt = require('jsonwebtoken')

jest.mock('../services/wm/wmApiClient', () => ({
  consultarProdutos: jest.fn(),
  prepararOrcamento: jest.fn(),
  criarOrcamento: jest.fn(),
}))
jest.mock('../services/wm/wmIntegrationConfigService', () => ({
  obterConfigInterna: jest.fn(),
}))
jest.mock('../helpers/permissoesService', () => ({ usuarioTemPermissao: jest.fn() }))
jest.mock('../services/chat/access/conversationPolicy', () => ({
  assertPermissaoConversa: jest.fn(),
  podeAssumirConversaPorPerfil: jest.fn(),
  assertPodeEnviarMensagem: jest.fn(),
}))

const wmApiClient = require('../services/wm/wmApiClient')
const configService = require('../services/wm/wmIntegrationConfigService')
const { usuarioTemPermissao } = require('../helpers/permissoesService')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const orcamentoWmFlag = require('../helpers/orcamentoWmFlag')
const service = require('../services/wm/wmOrcamentoService')
const stateMachine = require('../services/wm/wmOrcamentoStateMachine')
const { criarFakeDb } = require('./fixtures/wmOperacoesFakeDb')
const fx = require('./fixtures/wmPreviaReal')

const RAIZ = path.join(__dirname, '..')
const TELEFONE_EMPRESA_1 = '5534991847800'
const TELEFONE_EMPRESA_2 = '5511988887777'

let db
let fetchEspiao

function rascunhoBase(extra = {}) {
  return {
    conversa_id: 501,
    cliente_busca: 'joao',
    vendedor_busca: 'carlos',
    itens: [
      { codigo_produto_erp: 'P001', quantidade: '2' },
      { busca: 'notebook', quantidade: '1' },
    ],
    ...extra,
  }
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  delete process.env.WM_ORCAMENTOS_BLOQUEAR_APOS_CRIAR
  delete process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS

  fetchEspiao = jest.fn(() => { throw new Error('nenhum teste pode fazer rede real') })
  global.fetch = fetchEspiao

  db = criarFakeDb()
  usuarioTemPermissao.mockResolvedValue(true)
  assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { id: 501, tipo: 'individual', telefone: '5531999990000' } })
  configService.obterConfigInterna.mockImplementation(async (cid) => {
    const mapa = { 1: TELEFONE_EMPRESA_1, 2: TELEFONE_EMPRESA_2 }
    const telefone = mapa[Number(cid)]
    if (!telefone) return null
    return {
      company_id: Number(cid),
      ativo: true,
      telefone_autorizado: telefone,
      telefone_ultimos4: telefone.slice(-4),
      atualizado_em: '2026-10-20T12:00:00.000Z',
    }
  })
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

// =============================================================================
// 1. Laço de ambiguidade
// =============================================================================
describe('ambiguidade: devolve o rascunho inteiro e nunca escolhe sozinho', () => {
  it('cliente ambíguo volta com candidatos enriquecidos, paginação e o rascunho intacto', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeCliente()))
    const rascunho = rascunhoBase()

    const r = await service.preparar({ company_id: 1, usuario_id: 9, rascunho })

    expect(r.ok).toBe(true)
    expect(r.resultado.status).toBe('multiplos_clientes')
    expect(r.resultado.candidatos).toHaveLength(2)
    expect(r.resultado.candidatos[0]).toEqual({
      codigo_cliente_erp: 'C0001',
      nome: 'JOAO DA SILVA',
      cpf: '111.111.111-11',
      cnpj: null,
      inscricao_estadual: null,
    })
    expect(r.resultado.paginacao).toEqual({ pagina: 1, tamanho_pagina: 30, total: 94, tem_mais: true, tem_anterior: false })
    // O rascunho volta inteiro — é ele que o navegador reenvia com a escolha ou com a página.
    expect(r.resultado.rascunho).toEqual(rascunho)
    // Ambiguidade não cria operação: não há o que confirmar, e persistir candidatos guardaria
    // CPF/CNPJ/IE de gente que o atendente nem escolheu.
    expect(db.operacoes).toHaveLength(0)
  })

  it('vendedor ambíguo volta com os dois campos do contrato e nada mais', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeVendedor()))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.resultado.status).toBe('multiplos_vendedores')
    expect(Object.keys(r.resultado.candidatos[0]).sort()).toEqual(['codigo_vendedor_erp', 'nome'])
    expect(db.operacoes).toHaveLength(0)
  })

  it('produto ambíguo com indice_item DIFERENTE de zero sobrevive à ida e à volta', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeProduto({ indice_item: 1 })))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.resultado.status).toBe('produto_ambiguo')
    expect(r.resultado.indice_item).toBe(1)
    // O item 1 do rascunho é o que está ambíguo; o item 0 segue resolvido por código.
    expect(r.resultado.rascunho.itens[1].busca).toBe('notebook')
    expect(r.resultado.rascunho.itens[0].codigo_produto_erp).toBe('P001')
    // Candidato de produto da PREPARAÇÃO tem preço e estoque realtime (o de /produtos não tem),
    // e o estoque pode ser negativo.
    expect(r.resultado.candidatos[0].preco_unitario).toBe('33.038')
    expect(r.resultado.candidatos[0].estoque_previsto).toBe('-2.125')
  })

  it('produto ambíguo com indice_item fora do rascunho é resposta inválida, não "item 0"', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeProduto({ indice_item: 9 })))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
    expect(db.operacoes).toHaveLength(0)
  })

  it('produto ambíguo sem indice_item não é aceito', async () => {
    const resposta = fx.ambiguidadeProduto({ indice_item: 1 })
    delete resposta.dados.indice_item
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(resposta))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
  })

  it('ÚLTIMA PÁGINA COM UM ÚNICO CANDIDATO E total > 1 NÃO resolve sozinha', async () => {
    // `04-contratos-api.md`: "A última página com um único registro não resolve
    // automaticamente se total>1". É a armadilha mais fácil de cair — e a mais cara.
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeCliente({
      pagina: 4,
      total: 91,
      tem_mais: false,
      tem_anterior: true,
      candidatos: [{ codigo_cliente_erp: 'C9999', nome: 'ULTIMO DA LISTA', cpf: null, cnpj: null, inscricao_estadual: null }],
    })))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.ok).toBe(true)
    expect(r.resultado.status).toBe('multiplos_clientes')
    expect(r.resultado.candidatos).toHaveLength(1)
    expect(r.resultado.paginacao.total).toBe(91)
    // Não virou preparação pronta, não gravou nada, não escolheu o único candidato.
    expect(r.resultado.preparacao_id).toBeUndefined()
    expect(db.operacoes).toHaveLength(0)
  })

  it('um único candidato com total = 1 também continua ambiguidade — não há caminho de auto-seleção', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeVendedor({ total: 1 })))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.resultado.status).toBe('multiplos_vendedores')
    expect(r.resultado.preparacao_id).toBeUndefined()
  })
})

// =============================================================================
// 2. Paginação
// =============================================================================
describe('paginação preserva o rascunho e só troca os candidatos', () => {
  it('a página pedida vai para a WM e o rascunho volta igual, com outra lista', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeCliente({ pagina: 1 })))
    const r1 = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    const rascunhoPagina2 = rascunhoBase({ cliente_pagina: 2 })
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeCliente({
      pagina: 2,
      tem_anterior: true,
      candidatos: [{ codigo_cliente_erp: 'C0031', nome: 'JOAO SEGUNDA PAGINA', cpf: null, cnpj: null, inscricao_estadual: null }],
    })))
    const r2 = await service.preparar({ company_id: 1, rascunho: rascunhoPagina2 })

    // O payload enviado leva a página pedida, sem clamp e sem inventar tamanho_pagina.
    const enviado = wmApiClient.prepararOrcamento.mock.calls[1][0]
    expect(enviado.cliente_pagina).toBe(2)
    expect(enviado.tamanho_pagina).toBeUndefined()

    // Trocou a lista; o resto do rascunho (cliente_busca, vendedor_busca, itens) é idêntico.
    expect(r2.resultado.candidatos[0].codigo_cliente_erp).toBe('C0031')
    expect(r1.resultado.candidatos[0].codigo_cliente_erp).toBe('C0001')
    expect(r2.resultado.rascunho.itens).toEqual(rascunhoBase().itens)
    expect(r2.resultado.rascunho.cliente_busca).toBe('joao')
    expect(r2.resultado.rascunho.vendedor_busca).toBe('carlos')
    expect(r2.resultado.paginacao).toEqual({ pagina: 2, tamanho_pagina: 30, total: 94, tem_mais: true, tem_anterior: true })
  })

  it('página além da última é 400 PAGINA_FORA_DO_INTERVALO, sem clamp e com a página pedida', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoErro({ status: 400, erroWm: 'PAGINA_FORA_DO_INTERVALO' }))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase({ cliente_pagina: 999 }) })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(400)
    expect(r.envelope.codigo).toBe('WM_PAGINA_FORA_DO_INTERVALO')
    expect(wmApiClient.prepararOrcamento).toHaveBeenCalledTimes(1)
    expect(wmApiClient.prepararOrcamento.mock.calls[0][0].cliente_pagina).toBe(999)
    expect(db.operacoes).toHaveLength(0)
  })

  it('o 502 de resolução de produto repassa indice_item zero-based no envelope', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoErro({ status: 502, erroWm: 'PRODUTO_INATIVO', indiceItem: 1 }))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_PRODUTO_INATIVO')
    expect(r.envelope.indice_item).toBe(1)
  })
})

// =============================================================================
// 3. Preparação pronta: snapshot server-side
// =============================================================================
describe('pronto_para_confirmacao: snapshot server-side', () => {
  it('devolve só preparacao_id + prévia, e persiste o payload de criação com hash', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const r = await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunhoBase() })

    expect(r.ok).toBe(true)
    expect(r.resultado.status).toBe('pronto_para_confirmacao')
    expect(r.resultado.preparacao_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.resultado.expira_em).toBeTruthy()
    // A UI NÃO recebe o payload de criação nem o hash: não tem o que devolver na confirmação.
    expect(r.resultado.payload_criacao).toBeUndefined()
    expect(r.resultado.payload_hash).toBeUndefined()
    expect(r.resultado.comando_id).toBeUndefined()

    expect(db.operacoes).toHaveLength(1)
    const row = db.operacoes[0]
    expect(row.estado).toBe('PREPARADO')
    expect(row.company_id).toBe(1)
    expect(row.usuario_id).toBe(9)
    expect(row.conversa_id).toBe(501)
    expect(row.comando_id).toBeNull()
    expect(row.payload_hash).toBe(stateMachine.calcularPayloadHash(row.payload_criacao))
    expect(row.payload_criacao).toEqual({
      cliente_codigo_erp: 'C0001',
      vendedor_codigo_erp: 'V0007',
      bloquear_apos_criar: true,
      itens: [
        // §9.2: a quantidade da CRIAÇÃO é a da PRÉVIA — a WM devolve `2.000` para o `2` que
        // enviamos, e é isso que vai no payload.
        { codigo_produto_erp: 'P001', quantidade: '2.000', preco_confirmado: '33.038' },
        { codigo_produto_erp: 'P002', quantidade: '1.000', preco_confirmado: '1200.500' },
      ],
    })
  })

  it('a prévia sanitizada leva os campos reais do contrato para a UI', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    const previa = r.resultado.previa
    expect(previa.cliente).toEqual({ codigo_cliente_erp: 'C0001', nome: 'JOAO DA SILVA' })
    expect(previa.vendedor).toEqual({ codigo_vendedor_erp: 'V0007', nome: 'CARLOS SOUZA' })
    expect(previa.valor_produtos).toBe('1266.576')
    expect(previa.valor_total).toBe('1266.576')
    expect(previa.bloquear_apos_criar).toBe(true)
    // Itens: só os campos de §8, nada adivinhado (não existe `unidade` na prévia documentada).
    // `valor_total_bruto` e `valor_desconto_unit` entram por serem do contrato e por um motivo
    // concreto: sem eles um desconto aplicado pelo ERP apareceria só como um total menor, sem
    // dizer de onde veio, e o atendente não teria como explicar o preço ao cliente.
    expect(Object.keys(previa.itens[0]).sort()).toEqual(
      ['codigo_produto_erp', 'descricao', 'estoque_previsto', 'preco_unitario', 'quantidade',
        'valor_desconto_unit', 'valor_total', 'valor_total_bruto']
    )
    expect(previa.itens[0]).toEqual({
      codigo_produto_erp: 'P001',
      descricao: 'NOTEBOOK LENOVO IDEAPAD',
      quantidade: '2.000',
      preco_unitario: '33.038',
      estoque_previsto: '10.000',
      valor_total: '66.076',
      // A fixture não traz os dois: ausente vira null, nunca zero — "sem desconto" e "não
      // informado" são coisas diferentes na hora de exibir.
      valor_total_bruto: null,
      valor_desconto_unit: null,
    })
    // Estoque previsto pode ser NEGATIVO e atravessa como texto, sem virar conta.
    expect(previa.itens[1].estoque_previsto).toBe('-2.125')
  })

  it('o exemplo documentado da WM (§8), byte a byte, atravessa inteiro', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaDocumentada()))

    const r = await service.preparar({
      company_id: 1,
      rascunho: { conversa_id: 501, cliente_codigo_erp: '0000108', vendedor_codigo_erp: '001', itens: [{ codigo_produto_erp: '0000474', quantidade: '2' }] },
    })

    expect(r.ok).toBe(true)
    // Exatamente o corpo de §9.1 do guia, menos telefone e comando_id (injetados no despacho).
    expect(db.operacoes[0].payload_criacao).toEqual({
      cliente_codigo_erp: '0000108',
      vendedor_codigo_erp: '001',
      bloquear_apos_criar: true,
      itens: [{ codigo_produto_erp: '0000474', quantidade: '2.000', preco_confirmado: '28.900' }],
    })
    expect(r.resultado.previa.valor_total).toBe('57.80')
    expect(r.resultado.previa.itens[0].valor_total).toBe('57.80')
  })

  it('meta.fonte atravessa, e só `tempo_real` pode ser tratado como atual', async () => {
    // `meta` é só `type: object` no openapi.yaml: `fonte` pode faltar. E `cache_cloud` NUNCA
    // pode ser rotulado como atual — por isso `tempo_real` é derivado aqui, não na tela.
    const casos = [
      ['tempo_real', { fonte: 'tempo_real', tempo_real: true }],
      ['cache_cloud', { fonte: 'cache_cloud', tempo_real: false }],
      ['algo_novo_da_wm', { fonte: 'algo_novo_da_wm', tempo_real: false }],
      [null, { fonte: null, tempo_real: false }],
    ]
    for (const [fonte, esperado] of casos) {
      wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta({ fonte })))
      const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
      expect(r.resultado.previa.meta).toEqual(esperado)
    }
  })

  it('o preço é copiado BYTE A BYTE — três decimais e zero à direita intactos', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    const itens = db.operacoes[0].payload_criacao.itens
    expect(itens[0].preco_confirmado).toBe('33.038')
    expect(itens[1].preco_confirmado).toBe('1200.500') // não virou '1200.5'
    expect(r.resultado.previa.itens[1].preco_unitario).toBe('1200.500')
    // Quem passar por Number produz 1200.5 — este é o teste que pega isso.
    expect(String(Number(itens[1].preco_confirmado))).not.toBe(itens[1].preco_confirmado)
  })

  it('o snapshot NÃO guarda telefone nem comando_id, e nada deles sai na resposta', async () => {
    process.env.ZAPERP_API_TOKEN = 'zaperp_tok_NUNCA_SAIR'
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    const persistido = JSON.stringify(db.operacoes[0])
    expect(persistido).not.toContain(TELEFONE_EMPRESA_1)
    expect(persistido).not.toContain('zaperp_tok_NUNCA_SAIR')
    expect(db.operacoes[0].payload_criacao.telefone).toBeUndefined()
    expect(db.operacoes[0].payload_criacao.comando_id).toBeUndefined()

    const resposta = JSON.stringify(r.resultado)
    expect(resposta).not.toContain(TELEFONE_EMPRESA_1)
    expect(resposta).not.toContain('zaperp_tok_NUNCA_SAIR')
    delete process.env.ZAPERP_API_TOKEN
  })

  it('a prévia sanitizada não carrega CPF/CNPJ/IE do cliente escolhido', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    const texto = JSON.stringify(r.resultado.previa)
    expect(texto).not.toContain('123.456.789-00')
    expect(texto).not.toContain('ISENTO')
    expect(r.resultado.previa.cliente).toEqual({ codigo_cliente_erp: 'C0001', nome: 'JOAO DA SILVA' })
    expect(r.resultado.previa.valor_total).toBe('1266.576')
    // Nem o documento do candidato ESCOLHIDO entra na prévia sanitizada.
    expect(r.resultado.previa.cliente).not.toHaveProperty('cpf')
  })

  it('código canônico ACHATADO na raiz não é mais aceito (era hipótese da 4A)', async () => {
    // A costura provisória tolerava `dados.previa.cliente_codigo_erp`. O shape real de §8 põe
    // cliente e vendedor em objetos canônicos; outra forma é resposta fora do contrato.
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const achatada = fx.previaPronta()
    achatada.dados.cliente_codigo_erp = achatada.dados.cliente.codigo_cliente_erp
    delete achatada.dados.cliente
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(achatada))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
    expect(db.operacoes).toHaveLength(0)
    aviso.mockRestore()
  })
})

// =============================================================================
// 4. A tradução do contrato — falha alto, nunca adivinha
// =============================================================================
describe('extração prévia → payload (§8/§9.2): recusa em vez de adivinhar', () => {
  function previaComItem(patch) {
    const base = fx.previaPronta({ itens: [{ codigo: 'P001', quantidade: '2.000', preco: '33.038' }] })
    Object.assign(base.dados.itens[0], patch)
    return base
  }

  it.each([
    ['preço numérico (desvio de float)', { preco_unitario: 33.038 }],
    ['preço com vírgula', { preco_unitario: '33,038' }],
    ['preço negativo', { preco_unitario: '-33.038' }],
    ['preço vazio', { preco_unitario: '' }],
    ['sem código de produto', { codigo_produto_erp: null }],
    ['código de produto além de 7 caracteres', { codigo_produto_erp: '12345678' }],
  ])('%s: a preparação é recusada e nada é persistido', async (_nome, patch) => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(previaComItem(patch)))
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await service.preparar({
      company_id: 1,
      rascunho: { conversa_id: 501, cliente_busca: 'joao', vendedor_busca: 'carlos', itens: [{ codigo_produto_erp: 'P001', quantidade: '2' }] },
    })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
    expect(r.envelope.estado).toBe('FALHA_SEGURA')
    expect(db.operacoes).toHaveLength(0)
    aviso.mockRestore()
  })

  it('prévia sem cliente ou vendedor canônico é recusada', async () => {
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})
    for (const chave of ['cliente', 'vendedor']) {
      const previa = fx.previaPronta()
      delete previa.dados[chave]
      wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(previa))
      const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
      expect(r.ok).toBe(false)
      expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
    }
    expect(db.operacoes).toHaveLength(0)
    aviso.mockRestore()
  })

  it('contagem de itens diferente da enviada é recusada (sem casar por heurística)', async () => {
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})
    // Rascunho com 2 itens, prévia com 1.
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(
      fx.previaPronta({ itens: [{ codigo: 'P001', quantidade: '2', preco: '33.038' }] })
    ))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(r.ok).toBe(false)
    expect(db.operacoes).toHaveLength(0)
    aviso.mockRestore()
  })

  it('a função isolada devolve payload + prévia, sem telefone e sem marca de provisório', () => {
    const resposta = fx.previaPronta()
    const a = service.extrairPayloadCriacaoDaPrevia({
      dados: resposta.dados,
      meta: resposta.meta,
      rascunho: rascunhoBase(),
      bloquear_apos_criar: true,
    })
    expect(a.ok).toBe(true)
    expect(Object.keys(a.payload_criacao).sort()).toEqual(['bloquear_apos_criar', 'cliente_codigo_erp', 'itens', 'vendedor_codigo_erp'])
    // A 4B apagou a flag: o shape não é mais hipótese.
    expect(a.previa_sanitizada).not.toHaveProperty('previa_schema_provisorio')
    expect(a.previa_sanitizada.meta).toEqual({ fonte: 'tempo_real', tempo_real: true })
    expect(a.bloqueio_divergente).toBe(false)

    const vazio = service.extrairPayloadCriacaoDaPrevia({ dados: { status: 'pronto_para_confirmacao' }, rascunho: rascunhoBase(), bloquear_apos_criar: true })
    expect(vazio.ok).toBe(false)
    expect(vazio.motivo).toBe('previa_sem_itens')
  })

  it('PROIBIDO derivar preço de valor_total / quantidade', () => {
    // §8.1: o preço sai de `preco_unitario` e de lugar nenhum mais. Aqui a prévia traz
    // `valor_total` e `quantidade` coerentes, mas o `preco_unitario` ausente — se alguém
    // "ajudasse" dividindo, daria 28.9 (escala perdida) e passaria. Tem de falhar.
    const dados = fx.previaDocumentada().dados
    delete dados.itens[0].preco_unitario
    const r = service.extrairPayloadCriacaoDaPrevia({
      dados,
      rascunho: { itens: [{ codigo_produto_erp: '0000474', quantidade: '2' }] },
      bloquear_apos_criar: true,
    })
    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('previa_preco_invalido')
  })

  it('a quantidade da PRÉVIA vence a do rascunho (ordem fixada por §9.2)', () => {
    const dados = fx.previaPronta({ itens: [{ codigo: 'P001', quantidade: '2.000', preco: '33.038' }] }).dados
    const r = service.extrairPayloadCriacaoDaPrevia({
      dados,
      rascunho: { itens: [{ codigo_produto_erp: 'P001', quantidade: '2' }] },
      bloquear_apos_criar: true,
    })
    expect(r.ok).toBe(true)
    expect(r.payload_criacao.itens[0].quantidade).toBe('2.000')
  })

  it('bloquear_apos_criar da prévia vence a política, e a divergência é sinalizada', () => {
    // §9.2 manda copiar o da prévia: é sob aquela política que o preço foi calculado. Mas a
    // divergência não pode passar calada (pendência 10 exige o MESMO valor nas duas pontas).
    const divergente = service.extrairPayloadCriacaoDaPrevia({
      dados: fx.previaPronta({ bloquear_apos_criar: false }).dados,
      rascunho: rascunhoBase(),
      bloquear_apos_criar: true,
    })
    expect(divergente.ok).toBe(true)
    expect(divergente.payload_criacao.bloquear_apos_criar).toBe(false)
    expect(divergente.previa_sanitizada.bloquear_apos_criar).toBe(false)
    expect(divergente.bloqueio_divergente).toBe(true)

    // Prévia sem o campo: cai na política da empresa, sem divergência.
    const semCampo = fx.previaPronta()
    delete semCampo.dados.bloquear_apos_criar
    const herdado = service.extrairPayloadCriacaoDaPrevia({
      dados: semCampo.dados,
      rascunho: rascunhoBase(),
      bloquear_apos_criar: true,
    })
    expect(herdado.payload_criacao.bloquear_apos_criar).toBe(true)
    expect(herdado.bloqueio_divergente).toBe(false)
  })

  it('quantidade cai para a que NÓS enviamos quando a prévia não a traz como string', async () => {
    // Nunca um número da prévia convertido — a quantidade enviada já é string validada > 0.
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(previaComItem({ quantidade: 2 })))

    const r = await service.preparar({
      company_id: 1,
      rascunho: { conversa_id: 501, cliente_busca: 'joao', vendedor_busca: 'carlos', itens: [{ codigo_produto_erp: 'P001', quantidade: '2' }] },
    })

    expect(r.ok).toBe(true)
    expect(db.operacoes[0].payload_criacao.itens[0].quantidade).toBe('2')
  })
})

// =============================================================================
// 5. bloquear_apos_criar — mesma política nas duas chamadas
// =============================================================================
describe('bloquear_apos_criar (pendência 10)', () => {
  it('default true: vai em preparar E fica no snapshot', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(wmApiClient.prepararOrcamento.mock.calls[0][0].bloquear_apos_criar).toBe(true)
    expect(db.operacoes[0].payload_criacao.bloquear_apos_criar).toBe(true)
    expect(db.operacoes[0].previa_sanitizada.bloquear_apos_criar).toBe(true)
  })

  it('desligada por ambiente: o MESMO valor nas duas pontas', async () => {
    process.env.WM_ORCAMENTOS_BLOQUEAR_APOS_CRIAR = 'false'
    // A WM ecoa na prévia a política sob a qual calculou — é o caso normal (§8).
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta({ bloquear_apos_criar: false })))

    await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(wmApiClient.prepararOrcamento.mock.calls[0][0].bloquear_apos_criar).toBe(false)
    expect(db.operacoes[0].payload_criacao.bloquear_apos_criar).toBe(false)
    expect(db.operacoes[0].previa_sanitizada.bloquear_apos_criar).toBe(false)
  })

  it('prévia que ecoa valor diferente da política vence, com aviso no log', async () => {
    // §9.2 manda copiar o da prévia (foi sob ele que o preço foi calculado); a divergência não
    // pode passar calada, porque a pendência 10 exige o MESMO valor nas duas pontas.
    process.env.WM_ORCAMENTOS_BLOQUEAR_APOS_CRIAR = 'false'
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta({ bloquear_apos_criar: true })))

    await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(wmApiClient.prepararOrcamento.mock.calls[0][0].bloquear_apos_criar).toBe(false)
    expect(db.operacoes[0].payload_criacao.bloquear_apos_criar).toBe(true)
    expect(aviso).toHaveBeenCalled()
    expect(JSON.stringify(aviso.mock.calls)).toMatch(/bloquear_apos_criar da prévia difere/)
    aviso.mockRestore()
  })

  it('é obrigatório no payload da WM — o validador local barraria a ausência', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))
    await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    expect(wmApiClient.prepararOrcamento.mock.calls[0][0]).toHaveProperty('bloquear_apos_criar')
  })
})

// =============================================================================
// 6. Expiração e invalidação
// =============================================================================
describe('expiração local e invalidação da preparação anterior', () => {
  it('expira_em fica no futuro, dentro do TTL configurado', async () => {
    process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS = String(5 * 60 * 1000)
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const antes = Date.now()
    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    const expira = Date.parse(r.resultado.expira_em)

    expect(expira).toBeGreaterThan(antes)
    expect(expira).toBeLessThanOrEqual(antes + 5 * 60 * 1000 + 2000)
  })

  it('TTL fora da faixa cai para a faixa — nunca preparação eterna', () => {
    process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS = '1'
    expect(service.ttlPreparacaoMs()).toBe(60 * 1000)
    process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS = String(99 * 60 * 60 * 1000)
    expect(service.ttlPreparacaoMs()).toBe(60 * 60 * 1000)
    process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS = 'abc'
    expect(service.ttlPreparacaoMs()).toBe(service.TTL_PREPARACAO_PADRAO_MS)
  })

  it.each([
    ['quantidade', { itens: [{ codigo_produto_erp: 'P001', quantidade: '3' }, { busca: 'notebook', quantidade: '1' }] }],
    ['cliente', { cliente_busca: 'maria' }],
    ['vendedor', { vendedor_codigo_erp: 'V0099', vendedor_busca: undefined }],
    ['produto', { itens: [{ codigo_produto_erp: 'P555', quantidade: '2' }, { busca: 'notebook', quantidade: '1' }] }],
  ])('alterar %s e repreparar invalida a preparação anterior', async (_campo, mudanca) => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const primeira = await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunhoBase() })
    const rascunho2 = { ...rascunhoBase(), ...mudanca }
    if (rascunho2.vendedor_busca === undefined) delete rascunho2.vendedor_busca
    const segunda = await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunho2 })

    expect(segunda.resultado.preparacao_id).not.toBe(primeira.resultado.preparacao_id)
    const antiga = db.operacoes.find((o) => o.id === primeira.resultado.preparacao_id)
    const nova = db.operacoes.find((o) => o.id === segunda.resultado.preparacao_id)
    expect(antiga.estado).toBe('EXPIRADO')
    expect(nova.estado).toBe('PREPARADO')
  })

  it('a invalidação só atinge PREPARADO — ENVIANDO, CRIADO e INCERTO ficam intactos', async () => {
    db = criarFakeDb({
      linhas: [
        { id: '11111111-1111-4111-8111-111111111111', company_id: 1, usuario_id: 9, conversa_id: 501, estado: 'ENVIANDO', comando_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { id: '22222222-2222-4222-8222-222222222222', company_id: 1, usuario_id: 9, conversa_id: 501, estado: 'CRIADO' },
        { id: '33333333-3333-4333-8333-333333333333', company_id: 1, usuario_id: 9, conversa_id: 501, estado: 'INCERTO' },
      ],
    })
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunhoBase() })

    expect(db.operacoes.find((o) => o.estado === 'ENVIANDO')).toBeTruthy()
    expect(db.operacoes.find((o) => o.id.startsWith('22222222')).estado).toBe('CRIADO')
    expect(db.operacoes.find((o) => o.id.startsWith('33333333')).estado).toBe('INCERTO')
    const update = db.chamadas.find((c) => c.modo === 'update')
    expect(update.filtros).toEqual(expect.arrayContaining([['eq', 'estado', 'PREPARADO']]))
  })

  it('preparação de outro usuário na mesma conversa não é invalidada', async () => {
    db = criarFakeDb({
      linhas: [{ id: '44444444-4444-4444-8444-444444444444', company_id: 1, usuario_id: 77, conversa_id: 501, estado: 'PREPARADO' }],
    })
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunhoBase() })

    expect(db.operacoes.find((o) => o.usuario_id === 77).estado).toBe('PREPARADO')
  })
})

// =============================================================================
// 7. Isolamento
// =============================================================================
describe('isolamento: company_id do JWT, telefone do servidor, toda query filtrada', () => {
  it('o telefone enviado é o resolvido para o company_id recebido', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.ambiguidadeCliente()))

    await service.preparar({ company_id: 2, rascunho: rascunhoBase() })

    expect(configService.obterConfigInterna).toHaveBeenCalledWith(2)
    expect(wmApiClient.prepararOrcamento.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_2)
  })

  it('empresa sem vínculo não chega à WM', async () => {
    const r = await service.preparar({ company_id: 3, rascunho: rascunhoBase() })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_INTEGRACAO_NAO_CONFIGURADA')
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('integração inativa não chega à WM', async () => {
    configService.obterConfigInterna.mockResolvedValue({ company_id: 1, ativo: false, telefone_autorizado: TELEFONE_EMPRESA_1 })
    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    expect(r.ok).toBe(false)
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('telefone autorizado fora dos limites do contrato não vira chamada, e o erro não cita o valor', async () => {
    configService.obterConfigInterna.mockResolvedValue({ company_id: 1, ativo: true, telefone_autorizado: '123' })
    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r.envelope)).not.toContain('123')
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('company_id inválido não vira chamada externa com tenant indefinido', async () => {
    for (const cid of [undefined, null, 0, -1, 'x']) {
      const r = await service.preparar({ company_id: cid, rascunho: rascunhoBase() })
      expect(r.ok).toBe(false)
    }
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
    expect(configService.obterConfigInterna).not.toHaveBeenCalled()
  })

  it('toda query de wm_orcamento_operacoes carrega company_id', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))
    await service.preparar({ company_id: 1, usuario_id: 9, rascunho: rascunhoBase() })

    const daTabela = db.chamadas.filter((c) => c.tabela === 'wm_orcamento_operacoes')
    expect(daTabela.length).toBeGreaterThan(0)
    for (const c of daTabela) {
      const temFiltro = c.filtros.some(([op, col]) => op === 'eq' && col === 'company_id')
      const temNoPayload = c.modo === 'insert'
      expect(temFiltro || temNoPayload).toBe(true)
    }
    expect(db.operacoes[0].company_id).toBe(1)
  })

  it('os dois resolvedores de contato autorizado usam os mesmos limites do contrato', () => {
    // Gêmeos intencionais (leitura e orçamento resolvem a identidade independentemente).
    // Se um afrouxar o limite e o outro não, este teste cai.
    for (const arquivo of ['services/wm/wmAssistenteService.js', 'services/wm/wmOrcamentoService.js']) {
      const src = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8')
      expect(src).toContain('LIMITES.TELEFONE_MIN')
      expect(src).toContain('LIMITES.TELEFONE_MAX')
    }
  })
})

// =============================================================================
// 8. Nenhum retry automático de POST
// =============================================================================
describe('nenhum POST tem retry automático', () => {
  it('uma invocação de preparar = uma chamada à WM, mesmo em timeout', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoErro({ status: 0, transporte: 'timeout' }))

    const r = await service.preparar({ company_id: 1, rascunho: rascunhoBase() })

    expect(wmApiClient.prepararOrcamento).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    // Preparar não escreve: timeout aqui é falha segura, não incerto.
    expect(r.envelope.estado).toBe('FALHA_SEGURA')
  })

  it('o serviço nunca chama criarOrcamento — a criação é da Sessão 6', async () => {
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))
    await service.preparar({ company_id: 1, rascunho: rascunhoBase() })
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 9. HTTP: rota montada, conversa revalidada, identidade recusada
// =============================================================================
describe('POST /api/orcamentos/preparar (HTTP)', () => {
  let app

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
    app = require('../app')
  })

  function token(payload = {}) {
    return jwt.sign({ id: 9, company_id: 1, perfil: 'atendente', ...payload }, process.env.JWT_SECRET)
  }

  function ligarModulo() {
    jest.spyOn(orcamentoWmFlag, 'orcamentoWmHabilitado').mockResolvedValue(true)
  }

  const corpoValido = () => ({
    conversa_id: 501,
    cliente_busca: 'joao',
    vendedor_busca: 'carlos',
    itens: [{ codigo_produto_erp: 'P001', quantidade: '2' }, { busca: 'notebook', quantidade: '1' }],
  })

  it('com a flag desligada responde 403 de módulo (rota montada, não 404)', async () => {
    delete process.env.WM_ORCAMENTOS_ENABLED
    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpoValido())

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('revalida o acesso à conversa por assertPermissaoConversa antes de qualquer chamada externa', async () => {
    ligarModulo()
    assertPermissaoConversa.mockResolvedValue({ ok: false, status: 403, error: 'sem acesso' })

    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpoValido())

    expect(res.status).toBe(403)
    expect(res.body.codigo).toBe('ORCAMENTO_CONVERSA_NEGADA')
    expect(assertPermissaoConversa).toHaveBeenCalledWith(expect.objectContaining({ company_id: 1, conversa_id: 501, user_id: 9 }))
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('conversa de grupo não inicia orçamento', async () => {
    ligarModulo()
    assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { id: 501, tipo: 'grupo', telefone: '123@g.us' } })

    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpoValido())

    expect(res.status).toBe(422)
    expect(res.body.codigo).toBe('ORCAMENTO_CONVERSA_NAO_INDIVIDUAL')
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('conversa_id é obrigatório', async () => {
    ligarModulo()
    const corpo = corpoValido()
    delete corpo.conversa_id

    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpo)

    expect(res.status).toBe(400)
    expect(res.body.codigo).toBe('ORCAMENTO_DADOS_INVALIDOS')
    expect(assertPermissaoConversa).not.toHaveBeenCalled()
  })

  it.each(['telefone', 'company_id', 'comando_id', 'preco_confirmado', 'token', 'base_url', 'bloquear_apos_criar'])(
    'body com "%s" é RECUSADO, não sanitizado',
    async (campo) => {
      ligarModulo()
      const res = await request(app)
        .post('/api/orcamentos/preparar')
        .set('Authorization', `Bearer ${token()}`)
        .send({ ...corpoValido(), [campo]: 'qualquer' })

      expect(res.status).toBe(400)
      expect(res.body.codigo).toBe('ORCAMENTO_DADOS_INVALIDOS')
      expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
    }
  )

  it('quantidade <= 0 é barrada localmente (o padrão do contrato aceita "0")', async () => {
    ligarModulo()
    for (const quantidade of ['0', '0.000', '-1', 0, 1]) {
      const res = await request(app)
        .post('/api/orcamentos/preparar')
        .set('Authorization', `Bearer ${token()}`)
        .send({ ...corpoValido(), itens: [{ codigo_produto_erp: 'P001', quantidade }] })
      expect(res.status).toBe(400)
    }
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('sem a permissão orcamentos.ver é 403 e nada chega à WM', async () => {
    ligarModulo()
    usuarioTemPermissao.mockResolvedValue(false)

    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpoValido())

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PERMISSAO_NEGADA')
    expect(res.body.permissao).toBe('orcamentos.ver')
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('caminho comum: 200 com preparacao_id, sem telefone nem comando_id na resposta', async () => {
    ligarModulo()
    wmApiClient.prepararOrcamento.mockResolvedValue(fx.resultadoOk(fx.previaPronta()))

    const res = await request(app).post('/api/orcamentos/preparar').set('Authorization', `Bearer ${token()}`).send(corpoValido())

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.preparacao_id).toBeTruthy()
    expect(res.body.previa.itens[0].preco_unitario).toBe('33.038')
    const corpo = JSON.stringify(res.body)
    expect(corpo).not.toContain(TELEFONE_EMPRESA_1)
    expect(corpo).not.toMatch(/comando_id/i)
  })
})
