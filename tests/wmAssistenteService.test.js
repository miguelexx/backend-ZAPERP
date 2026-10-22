/**
 * Leitura de produtos do Assistente WM (doc 36, Sessão 3A).
 *
 * Tudo contra mock: `services/wm/wmApiClient` e `services/wm/wmIntegrationConfigService` são
 * substituídos, e `global.fetch` é um espião que FALHA se chamado — nenhum teste deste arquivo
 * toca a rede. As formas de resposta vêm do `docs/wm/openapi.yaml` (`ConsultarProdutoResposta`,
 * `PaginacaoConsulta`), não de memória.
 *
 * O que está sendo provado, em ordem de importância:
 *   1. o telefone enviado à WM é SEMPRE o resolvido no servidor para aquele company_id;
 *   2. empresa A não obtém nada da empresa B, inclusive via cache;
 *   3. preço e estoque não atravessam este endpoint, nem se a WM os mandar;
 *   4. nada é rotulado como "atual" (a origem declarada é `cache_cloud`);
 *   5. página fora do intervalo chega como 400, sem clamp;
 *   6. nem token nem telefone aparecem em log.
 */
const wmApiClient = require('../services/wm/wmApiClient')
const configService = require('../services/wm/wmIntegrationConfigService')
const cache = require('../services/wm/wmConsultaCache')
const service = require('../services/wm/wmAssistenteService')

jest.mock('../services/wm/wmApiClient', () => ({
  consultarProdutos: jest.fn(),
  prepararOrcamento: jest.fn(),
  criarOrcamento: jest.fn(),
}))

jest.mock('../services/wm/wmIntegrationConfigService', () => ({
  obterConfigInterna: jest.fn(),
}))

// Telefones de fixture: são o CONTATO AUTORIZADO da WM (não o da conversa, não o do comprador).
const TELEFONE_A = '5534991847800'
const TELEFONE_B = '5511988887777'
const VERSAO_A = '2026-10-20T12:00:00.000Z'
const VERSAO_B = '2026-10-20T12:30:00.000Z'

function configDe({ companyId, telefone, versao, ativo = true }) {
  return {
    id: companyId,
    company_id: companyId,
    ativo,
    telefone_autorizado: telefone,
    telefone_ultimos4: String(telefone).slice(-4),
    atualizado_em: versao,
  }
}

/** Resposta de ambiguidade, exatamente a forma de `ConsultarProdutoResposta`. */
function respostaMultiplos({ produtos, pagina = 1, total = 2, temMais = false, temAnterior = false, meta = { fonte: 'cache_cloud' } }) {
  return {
    ok: true,
    status: 200,
    operacao: 'leitura',
    data: {
      dados: {
        status: 'multiplos_produtos',
        produtos,
        paginacao: { pagina, tamanho_pagina: 30, total, tem_mais: temMais, tem_anterior: temAnterior },
      },
      meta,
    },
  }
}

function falhaWm({ status, erroWm = null, transporte = null, respostaInvalida = false }) {
  return {
    ok: false,
    status,
    operacao: 'leitura',
    data: null,
    erroWm,
    indiceItem: null,
    transporte,
    respostaInvalida,
    configuracaoInvalida: null,
  }
}

let fetchEspiao

beforeEach(() => {
  jest.clearAllMocks()
  cache.invalidar()
  delete process.env.WM_CACHE_TTL_MS
  delete process.env.WM_CACHE_MAX_ENTRADAS
  fetchEspiao = jest.fn(() => { throw new Error('nenhum teste pode fazer rede real') })
  global.fetch = fetchEspiao
  configService.obterConfigInterna.mockImplementation(async (cid) => {
    if (Number(cid) === 1) return configDe({ companyId: 1, telefone: TELEFONE_A, versao: VERSAO_A })
    if (Number(cid) === 2) return configDe({ companyId: 2, telefone: TELEFONE_B, versao: VERSAO_B })
    return null
  })
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

// =============================================================================
// Identidade: o telefone é do servidor, o company_id é de quem chama
// =============================================================================
describe('resolução do contato autorizado', () => {
  it('envia à WM o telefone resolvido para aquele company_id', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(
      respostaMultiplos({ produtos: [{ codigo_produto_erp: '0000474', descricao: 'CHAPA', marca: 'ACME', unidade: 'UN' }] })
    )

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(r.ok).toBe(true)
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0]).toEqual({ telefone: TELEFONE_A, busca: 'chapa' })
  })

  it('a mesma busca em outra empresa vai com o telefone da OUTRA empresa', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    await service.consultarProdutos({ company_id: 2, consulta: { busca: 'chapa' } })

    const telefonesEnviados = wmApiClient.consultarProdutos.mock.calls.map((c) => c[0].telefone)
    expect(telefonesEnviados).toEqual([TELEFONE_A, TELEFONE_B])
  })

  it('não há como o chamador injetar telefone: a chave do payload é sempre sobrescrita pela config', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    // Mesmo que algo (bug, body que passasse pelo validador) trouxesse `telefone` na consulta,
    // a consulta só contribui com busca/código/página — nada mais entra no payload.
    await service.consultarProdutos({
      company_id: 1,
      consulta: { busca: 'chapa', telefone: '5500000000000', company_id: 999 },
    })

    expect(wmApiClient.consultarProdutos.mock.calls[0][0]).toEqual({ telefone: TELEFONE_A, busca: 'chapa' })
  })

  it('empresa sem vínculo, inativa ou sem telefone não chega à WM', async () => {
    configService.obterConfigInterna.mockResolvedValue(null)
    const semVinculo = await service.consultarProdutos({ company_id: 9, consulta: { busca: 'chapa' } })

    configService.obterConfigInterna.mockResolvedValue(configDe({ companyId: 1, telefone: TELEFONE_A, versao: VERSAO_A, ativo: false }))
    const inativa = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    configService.obterConfigInterna.mockResolvedValue({ company_id: 1, ativo: true, telefone_autorizado: '   ', atualizado_em: VERSAO_A })
    const semTelefone = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    for (const r of [semVinculo, inativa, semTelefone]) {
      expect(r.ok).toBe(false)
      expect(r.httpStatus).toBe(503)
      expect(r.envelope.codigo).toBe('WM_INTEGRACAO_NAO_CONFIGURADA')
      expect(r.envelope.estado).toBe('FALHA_SEGURA')
    }
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })

  it('company_id inválido não vira chamada externa', async () => {
    for (const cid of [undefined, null, 0, -1, 'abc', {}]) {
      const r = await service.consultarProdutos({ company_id: cid, consulta: { busca: 'chapa' } })
      expect(r.ok).toBe(false)
      expect(r.httpStatus).toBe(503)
    }
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })

  it('consulta sem exatamente um entre busca e código não chega à WM', async () => {
    const nenhum = await service.consultarProdutos({ company_id: 1, consulta: {} })
    const ambos = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'x', codigo_produto_erp: '1' } })
    expect(nenhum.ok).toBe(false)
    expect(ambos.ok).toBe(false)
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })
})

// =============================================================================
// Projeção: lista branca de 4 campos, sem preço, sem estoque, sem "atual"
// =============================================================================
describe('projeção dos candidatos', () => {
  it('devolve só codigo/descricao/marca/unidade e preserva a paginação', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [
        { codigo_produto_erp: '0000474', descricao: 'CHAPA DESLIZANTE', marca: 'ACME', unidade: 'UN' },
        { codigo_produto_erp: '0000475', descricao: null, marca: null, unidade: null },
      ],
      pagina: 2,
      total: 94,
      temMais: true,
      temAnterior: true,
    }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa', pagina: 2 } })

    expect(r.ok).toBe(true)
    expect(r.dados.status).toBe('multiplos_produtos')
    expect(r.dados.produtos).toEqual([
      { codigo_produto_erp: '0000474', descricao: 'CHAPA DESLIZANTE', marca: 'ACME', unidade: 'UN' },
      { codigo_produto_erp: '0000475', descricao: null, marca: null, unidade: null },
    ])
    expect(r.dados.paginacao).toEqual({ pagina: 2, tamanho_pagina: 30, total: 94, tem_mais: true, tem_anterior: true })
  })

  it('descarta preço e estoque mesmo se a WM mandar neste endpoint', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [{
        codigo_produto_erp: '0000474',
        descricao: 'CHAPA',
        marca: 'ACME',
        unidade: 'UN',
        preco_unitario: '33.038',
        estoque_previsto: '-2.125',
        estoque_atual: '10.000',
      }],
    }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(Object.keys(r.dados.produtos[0]).sort()).toEqual(['codigo_produto_erp', 'descricao', 'marca', 'unidade'])
    const serializado = JSON.stringify(r.dados)
    expect(serializado).not.toContain('33.038')
    expect(serializado).not.toContain('-2.125')
    expect(serializado).not.toContain('preco')
    expect(serializado).not.toContain('estoque')
  })

  it('declara a origem dos candidatos como cache_cloud — nunca como dado atual', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    expect(r.dados.candidatos_origem).toBe('cache_cloud')
    expect(JSON.stringify(r.dados)).not.toMatch(/atual/i)
  })

  /**
   * O ramo RESOLVIDO tem lista branca MAIOR que a da lista, e isso é contrato, não descuido:
   * medido no ERP real em 22/10, a WM devolve aqui preço, estoque, `ativo` e identificadores,
   * com `meta.fonte: 'tempo_real'`. Descartá-los fazia a atendente escolher às cegas.
   */
  it('produto resolvido traz preço, estoque e identificadores — como STRING, byte a byte', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: {
          codigo_produto_erp: '0005205',
          descricao: 'FILTRO OLEO',
          codigo_barras: '2500051470008',
          codigo_fabricante: '04E115561L',
          marca: 'VOLKSWAGEN',
          unidade: 'M2',
          grupo: 'PECAS',
          subgrupo: 'FILTROS',
          preco_unitario: '0.010',
          estoque_previsto: '0.000',
          ativo: true,
        },
        meta: { fonte: 'tempo_real', consultado_em: '2026-10-22T20:14:47.481Z' },
      },
    })

    const r = await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: '0005205' } })

    expect(r.ok).toBe(true)
    expect(r.dados.status).toBe('produto')
    expect(r.dados.produto).toEqual({
      codigo_produto_erp: '0005205',
      descricao: 'FILTRO OLEO',
      codigo_barras: '2500051470008',
      codigo_fabricante: '04E115561L',
      marca: 'VOLKSWAGEN',
      unidade: 'M2',
      grupo: 'PECAS',
      subgrupo: 'FILTROS',
      preco_unitario: '0.010',
      estoque_previsto: '0.000',
      ativo: true,
    })
    // As casas decimais da WM chegam intactas: nada de 0.01 nem de Number.
    expect(typeof r.dados.produto.preco_unitario).toBe('string')
    expect(r.dados.meta.fonte).toBe('tempo_real')
  })

  it('preço fora do formato decimal textual vira null — nunca zero, nunca número', async () => {
    for (const bruto of [33.038, '33,038', '1e3', '', '  ', null, {}, true]) {
      wmApiClient.consultarProdutos.mockResolvedValue({
        ok: true,
        status: 200,
        operacao: 'leitura',
        data: {
          dados: { produto: { codigo_produto_erp: 'P1', descricao: 'X', preco_unitario: bruto, estoque_previsto: bruto } },
          meta: {},
        },
      })
      cache.invalidar()
      const r = await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: `P${String(bruto)}` } })
      expect(r.ok).toBe(true)
      expect(r.dados.produto.preco_unitario).toBeNull()
      expect(r.dados.produto.estoque_previsto).toBeNull()
    }
  })

  it('`ativo` só atravessa como booleano de verdade — omissão não vira "ativo"', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: { dados: { produto: { codigo_produto_erp: 'P1', descricao: 'X', ativo: 'sim' } }, meta: {} },
    })
    const r = await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: 'P1' } })
    expect(r.dados.produto.ativo).toBeNull()
  })

  it('a LISTA continua sem preço: o do resolvido não é reaproveitado para os candidatos', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [{ codigo_produto_erp: 'A', descricao: 'A', marca: null, unidade: 'UN' }],
    }))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'aaa' } })
    expect(Object.keys(r.dados.produtos[0]).sort()).toEqual(['codigo_produto_erp', 'descricao', 'marca', 'unidade'])
  })

  it('aceita o produto resolvido na raiz de dados (forma legada não modelada no OpenAPI)', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: { dados: { codigo_produto_erp: '0000474', descricao: 'CHAPA', marca: null, unidade: 'UN' }, meta: {} },
    })
    const r = await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: '0000474' } })
    expect(r.ok).toBe(true)
    expect(r.dados.produto.codigo_produto_erp).toBe('0000474')
  })

  it('paginação fora do formato do contrato vira null, sem inventar tem_mais', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: {
          status: 'multiplos_produtos',
          produtos: [{ codigo_produto_erp: '1', descricao: 'A', marca: null, unidade: 'UN' }],
          // Worker antigo, sem a paginação nova (rollout: Worker primeiro, API depois).
          paginacao: undefined,
        },
        meta: {},
      },
    })

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'a' } })
    expect(r.ok).toBe(true)
    expect(r.dados.paginacao).toBeNull()
    expect(r.dados.produtos).toHaveLength(1)
  })

  it('candidato sem código recusa a resposta inteira em vez de deixar buraco na lista', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [{ codigo_produto_erp: '1', descricao: 'A', marca: null, unidade: 'UN' }, { descricao: 'sem codigo' }],
    }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'a' } })
    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
    expect(r.httpStatus).toBe(503)
  })

  it('forma irreconhecível não é tratada como lista vazia', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: true, status: 200, operacao: 'leitura', data: { dados: { qualquer_coisa: true }, meta: {} },
    })
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'a' } })
    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESPOSTA_INVALIDA')
  })
})

// =============================================================================
// `meta` — o contrato só diz `type: object`
// =============================================================================
describe('meta defensivo', () => {
  it('preserva escalares conhecidos', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [], meta: { fonte: 'cache_cloud', sincronizado_em: '2026-10-20T11:00:00Z', paginas: 4, parcial: false },
    }))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'a' } })
    expect(r.dados.meta).toEqual({ fonte: 'cache_cloud', sincronizado_em: '2026-10-20T11:00:00Z', paginas: 4, parcial: false })
  })

  it('meta ausente, vazio ou não-objeto não quebra nada', async () => {
    for (const meta of [undefined, null, {}, 'texto', 42, []]) {
      // Montado à mão de propósito: o helper tem `meta` default, e aqui o ponto é meta ausente.
      wmApiClient.consultarProdutos.mockResolvedValue({
        ok: true,
        status: 200,
        operacao: 'leitura',
        data: {
          dados: { status: 'multiplos_produtos', produtos: [], paginacao: { pagina: 1, tamanho_pagina: 30, total: 0, tem_mais: false, tem_anterior: false } },
          meta,
        },
      })
      cache.invalidar()
      const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: `a${String(meta)}` } })
      expect(r.ok).toBe(true)
      expect(r.dados.meta).toBeNull()
    }
  })

  it('descarta aninhado e nunca repassa o telefone autorizado vindo do meta', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({
      produtos: [],
      meta: { fonte: 'cache_cloud', contexto: { interno: 'x' }, contato: `autorizado ${TELEFONE_A}` },
    }))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'a' } })
    expect(r.dados.meta).toEqual({ fonte: 'cache_cloud' })
    expect(JSON.stringify(r.dados)).not.toContain(TELEFONE_A)
  })
})

// =============================================================================
// Erros da WM
// =============================================================================
describe('erros da WM', () => {
  it('página fora do intervalo chega como 400, sem clamp nem página corrigida', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(falhaWm({ status: 400, erroWm: 'PAGINA_FORA_DO_INTERVALO' }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa', pagina: 99 } })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(400)
    expect(r.envelope.codigo).toBe('WM_PAGINA_FORA_DO_INTERVALO')
    // Nenhuma tentativa de "consertar" a página: uma chamada, e só.
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0].pagina).toBe(99)
    expect(r.dados).toBeUndefined()
  })

  it('401 da WM nunca vira 401 local (deslogaria o atendente)', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(falhaWm({ status: 401, erroWm: 'TOKEN_ASSISTENTE_INVALIDO' }))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    expect(r.httpStatus).toBe(503)
    expect(r.envelope.codigo).toBe('WM_CREDENCIAL_INVALIDA')
    expect(r.interno.alertaOperacional).toBe(true)
  })

  it('leitura nunca fica INCERTA — só criação pode', async () => {
    for (const falha of [
      falhaWm({ status: 0, transporte: 'timeout' }),
      falhaWm({ status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }),
      falhaWm({ status: 504, erroWm: 'REALTIME_TIMEOUT' }),
    ]) {
      wmApiClient.consultarProdutos.mockResolvedValue(falha)
      cache.invalidar()
      const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
      expect(r.ok).toBe(false)
      expect(r.envelope.estado).toBe('FALHA_SEGURA')
    }
  })

  it('erro não entra no cache: a chamada seguinte tenta de novo', async () => {
    wmApiClient.consultarProdutos.mockResolvedValueOnce(falhaWm({ status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }))
    wmApiClient.consultarProdutos.mockResolvedValueOnce(respostaMultiplos({ produtos: [] }))

    const primeiro = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    const segundo = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(primeiro.ok).toBe(false)
    expect(segundo.ok).toBe(true)
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
  })
})

// =============================================================================
// Cache e coalescência
// =============================================================================
describe('cache LRU', () => {
  it('a segunda busca idêntica não gasta chamada', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [{ codigo_produto_erp: '1', descricao: 'A', marca: null, unidade: 'UN' }] }))

    const a = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    const b = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(a.origem_resposta).toBe('fresco')
    expect(b.origem_resposta).toBe('cache')
    expect(b.dados).toEqual(a.dados)
  })

  it('página, termo e modo diferentes são entradas diferentes', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa', pagina: 2 } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'parafuso' } })
    await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: 'chapa' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(4)
  })

  it('página ausente e página 1 são a mesma entrada (1 é o default da WM)', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa', pagina: 1 } })
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
  })

  it('caixa diferente é outra entrada — a WM casa identificador por igualdade exata', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'CHAPA' } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: ' chapa' } })
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(3)
  })

  it('EMPRESA A NÃO LÊ O CACHE DA EMPRESA B', async () => {
    wmApiClient.consultarProdutos.mockImplementation(async (payload) => {
      if (payload.telefone === TELEFONE_A) {
        return respostaMultiplos({ produtos: [{ codigo_produto_erp: 'A1', descricao: 'DA EMPRESA A', marca: null, unidade: 'UN' }] })
      }
      return respostaMultiplos({ produtos: [{ codigo_produto_erp: 'B1', descricao: 'DA EMPRESA B', marca: null, unidade: 'UN' }] })
    })

    const a = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    const b = await service.consultarProdutos({ company_id: 2, consulta: { busca: 'chapa' } })
    const aDeNovo = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(a.dados.produtos[0].codigo_produto_erp).toBe('A1')
    expect(b.dados.produtos[0].codigo_produto_erp).toBe('B1')
    expect(b.origem_resposta).toBe('fresco')
    expect(aDeNovo.dados.produtos[0].codigo_produto_erp).toBe('A1')
    expect(aDeNovo.origem_resposta).toBe('cache')
    expect(JSON.stringify(a.dados)).not.toContain('EMPRESA B')
    expect(JSON.stringify(b.dados)).not.toContain('EMPRESA A')
  })

  it('mudar o vínculo da empresa (atualizado_em) invalida o cache', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)

    // Telefone novo = outra instalação da WM = outro catálogo. A versão muda, a chave muda.
    configService.obterConfigInterna.mockResolvedValue(
      configDe({ companyId: 1, telefone: TELEFONE_B, versao: '2026-10-21T08:00:00.000Z' })
    )
    const depois = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    expect(depois.origem_resposta).toBe('fresco')
    expect(wmApiClient.consultarProdutos.mock.calls[1][0].telefone).toBe(TELEFONE_B)
  })

  it('config sem atualizado_em não é cacheada (fail-safe, não "cacheia com o que der")', async () => {
    configService.obterConfigInterna.mockResolvedValue({ company_id: 1, ativo: true, telefone_autorizado: TELEFONE_A, atualizado_em: null })
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
  })

  it('entrada vencida é refeita', async () => {
    process.env.WM_CACHE_TTL_MS = '120000'
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))
    const agora = Date.now()
    const relogio = jest.spyOn(Date, 'now').mockReturnValue(agora)

    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    relogio.mockReturnValue(agora + 119_000)
    const dentro = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    relogio.mockReturnValue(agora + 121_000)
    const fora = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    expect(dentro.origem_resposta).toBe('cache')
    expect(fora.origem_resposta).toBe('fresco')
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    relogio.mockRestore()
  })

  it('respeita o teto de entradas descartando a mais antiga', async () => {
    process.env.WM_CACHE_MAX_ENTRADAS = '10'
    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))

    for (let i = 0; i < 12; i++) {
      await service.consultarProdutos({ company_id: 1, consulta: { busca: `termo${i}` } })
    }
    expect(cache._estado().entradas).toBe(10)

    // O primeiro termo caiu fora: consultá-lo de novo custa chamada.
    const chamadasAntes = wmApiClient.consultarProdutos.mock.calls.length
    await service.consultarProdutos({ company_id: 1, consulta: { busca: 'termo0' } })
    expect(wmApiClient.consultarProdutos.mock.calls.length).toBe(chamadasAntes + 1)
  })

  it('TTL fora da faixa de 2–5 min é limitado à faixa', () => {
    process.env.WM_CACHE_TTL_MS = '1000'
    expect(cache._estado().ttlMs).toBe(cache.TTL_MIN_MS)
    process.env.WM_CACHE_TTL_MS = '99999999'
    expect(cache._estado().ttlMs).toBe(cache.TTL_MAX_MS)
  })
})

describe('coalescência de requisições em voo', () => {
  it('N usuários com o mesmo termo ao mesmo tempo = UMA chamada externa', async () => {
    let resolver = null
    wmApiClient.consultarProdutos.mockImplementation(() => new Promise((r) => { resolver = r }))

    const promessas = [
      service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } }),
      service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } }),
      service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } }),
    ]
    // Dá uma volta no event loop para as três chegarem ao ponto de espera.
    await Promise.resolve()
    await new Promise((r) => setImmediate(r))

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    resolver(respostaMultiplos({ produtos: [{ codigo_produto_erp: 'X', descricao: 'X', marca: null, unidade: 'UN' }] }))

    const [a, b, c] = await Promise.all(promessas)
    expect(a.ok && b.ok && c.ok).toBe(true)
    expect(b.dados).toEqual(a.dados)
    expect(c.dados).toEqual(a.dados)
    expect([b.origem_resposta, c.origem_resposta]).toContain('coalescido')
  })

  it('empresas diferentes em voo NÃO coalescem entre si', async () => {
    const resolvedores = []
    wmApiClient.consultarProdutos.mockImplementation((payload) => new Promise((r) => resolvedores.push({ payload, r })))

    const pa = service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    const pb = service.consultarProdutos({ company_id: 2, consulta: { busca: 'chapa' } })
    await new Promise((r) => setImmediate(r))

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    for (const { payload, r } of resolvedores) {
      const marca = payload.telefone === TELEFONE_A ? 'A' : 'B'
      r(respostaMultiplos({ produtos: [{ codigo_produto_erp: marca, descricao: marca, marca: null, unidade: 'UN' }] }))
    }
    const [a, b] = await Promise.all([pa, pb])
    expect(a.dados.produtos[0].codigo_produto_erp).toBe('A')
    expect(b.dados.produtos[0].codigo_produto_erp).toBe('B')
  })

  it('falha em voo é compartilhada e não deixa a chave travada', async () => {
    wmApiClient.consultarProdutos.mockRejectedValueOnce(new Error('explodiu'))

    await expect(Promise.all([
      service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } }),
      service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } }),
    ])).rejects.toThrow('explodiu')

    expect(cache._estado().emVoo).toBe(0)

    wmApiClient.consultarProdutos.mockResolvedValue(respostaMultiplos({ produtos: [] }))
    const depois = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })
    expect(depois.ok).toBe(true)
  })
})

// =============================================================================
// Correspondência exata que esconde os irmãos
// =============================================================================
/**
 * Medido ao vivo contra o ERP da empresa 20 em 22/10:
 *   `filtro` → 1 · `filtr` → 468   |   `parafuso` → 1 · `parafus` → 285   |   `piso` → 1 · `pis` → 42
 *
 * Nos dois primeiros existe um produto chamado literalmente assim e a WM resolve nele,
 * escondendo os outros. No terceiro o resultado é único de verdade — e aí NÃO se gasta chamada.
 */
describe('irmãos escondidos pela correspondência exata', () => {
  /** Resposta resolvida com a descrição que o teste pedir. */
  function respostaResolvida(descricao, extra = {}) {
    return {
      ok: true,
      status: 200,
      operacao: 'leitura',
      data: {
        dados: { produto: { codigo_produto_erp: 'EXATO', descricao, marca: 'ACME', unidade: 'UN', ...extra } },
        meta: { fonte: 'tempo_real' },
      },
    }
  }

  const IRMAOS = [
    { codigo_produto_erp: 'EXATO', descricao: 'FILTRO', marca: 'ACME', unidade: 'UN' },
    { codigo_produto_erp: 'A1', descricao: 'FILTRO DE OLEO', marca: 'ACME', unidade: 'UN' },
    { codigo_produto_erp: 'A2', descricao: 'FILTRO DE AR', marca: 'ACME', unidade: 'UN' },
  ]

  it('termo IGUAL à descrição dispara a segunda consulta, com o termo encurtado em 1 caractere', async () => {
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('FILTRO'))
      .mockResolvedValueOnce(respostaMultiplos({ produtos: IRMAOS, total: 468, temMais: true }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0]).toEqual({ telefone: TELEFONE_A, busca: 'filtro' })
    expect(wmApiClient.consultarProdutos.mock.calls[1][0]).toEqual({ telefone: TELEFONE_A, busca: 'filtr' })

    expect(r.ok).toBe(true)
    expect(r.dados.status).toBe('multiplos_produtos')
    // O exato em PRIMEIRO, e marcado — a tela não precisa adivinhar qual é.
    expect(r.dados.produtos[0].codigo_produto_erp).toBe('EXATO')
    expect(r.dados.correspondencia_exata.codigo_produto_erp).toBe('EXATO')
    expect(r.dados.outros_com_a_palavra.map((p) => p.codigo_produto_erp)).toEqual(['A1', 'A2'])
    expect(r.dados.termo_dos_outros).toBe('filtr')
    // O total global dos escondidos chega à tela: é dele que sai "mostrar mais resultados".
    expect(r.dados.paginacao.total).toBe(468)
  })

  it('caixa e acento não impedem a detecção (a WM casa sem diferenciar os dois)', async () => {
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('PARAFUSO SEXTAVADO'))
      .mockResolvedValueOnce(respostaMultiplos({ produtos: [
        { codigo_produto_erp: 'EXATO', descricao: 'PARAFUSO SEXTAVADO', marca: null, unidade: 'UN' },
        { codigo_produto_erp: 'B1', descricao: 'PARAFUSO SEXTAVADO INOX', marca: null, unidade: 'UN' },
      ] }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: ' Parafuso  Sextavado ' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    expect(wmApiClient.consultarProdutos.mock.calls[1][0].busca).toBe('Parafuso  Sextavad')
    expect(r.dados.correspondencia_exata.codigo_produto_erp).toBe('EXATO')
  })

  it('termo apenas CONTIDO na descrição não gasta chamada nenhuma (caso `piso`)', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(
      respostaResolvida('PISO EXTENCAO PENEIRA 9650 9750')
    )

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'piso' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(r.dados.status).toBe('produto')
    expect(r.dados.produto.codigo_produto_erp).toBe('EXATO')
  })

  it('termo de 3 caracteres não encurta: `pis` viraria `pi` e varreria o catálogo', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaResolvida('PIS'))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'pis' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(r.dados.status).toBe('produto')
  })

  it('consulta por CÓDIGO nunca dispara a segunda busca', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue(respostaResolvida('FILTRO'))
    const r = await service.consultarProdutos({ company_id: 1, consulta: { codigo_produto_erp: 'FILTRO' } })
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(r.dados.status).toBe('produto')
  })

  it('a melhoria nunca piora o que já funcionava: falha, vazio, resolver de novo ou exceção devolvem o original', async () => {
    const segundasRuins = [
      falhaWm({ status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }),
      falhaWm({ status: 400, erroWm: 'PAGINA_FORA_DO_INTERVALO' }),
      respostaMultiplos({ produtos: [] }),
      // só o próprio exato: não há irmão a revelar
      respostaMultiplos({ produtos: [{ codigo_produto_erp: 'EXATO', descricao: 'FILTRO', marca: null, unidade: 'UN' }] }),
      // resolveu de novo em vez de listar
      respostaResolvida('FILTR'),
      // forma fora do contrato
      { ok: true, status: 200, operacao: 'leitura', data: { dados: { qualquer: true }, meta: {} } },
    ]

    for (const segunda of segundasRuins) {
      jest.clearAllMocks()
      cache.invalidar()
      wmApiClient.consultarProdutos
        .mockResolvedValueOnce(respostaResolvida('FILTRO'))
        .mockResolvedValueOnce(segunda)

      const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })

      expect(r.ok).toBe(true)
      expect(r.dados.status).toBe('produto')
      expect(r.dados.produto.codigo_produto_erp).toBe('EXATO')
    }

    // E se a segunda chamada LANÇAR, a resposta original continua de pé.
    jest.clearAllMocks()
    cache.invalidar()
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('FILTRO'))
      .mockRejectedValueOnce(new Error('explodiu'))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })
    expect(r.ok).toBe(true)
    expect(r.dados.status).toBe('produto')
  })

  it('a segunda consulta passa pelo MESMO cache: repetir a busca não gasta chamada nova', async () => {
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('FILTRO'))
      .mockResolvedValueOnce(respostaMultiplos({ produtos: IRMAOS }))

    const a = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })
    const b = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })

    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    expect(b.dados).toEqual(a.dados)

    // E quem digitar o termo encurtado à mão reusa a MESMA entrada de cache.
    const c = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtr' } })
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
    expect(c.origem_resposta).toBe('cache')
  })

  it('a empresa B não enxerga os irmãos da empresa A', async () => {
    wmApiClient.consultarProdutos.mockImplementation(async (payload) => {
      if (payload.busca === 'filtro') return respostaResolvida('FILTRO')
      return payload.telefone === TELEFONE_A
        ? respostaMultiplos({ produtos: [...IRMAOS] })
        : respostaMultiplos({ produtos: [{ codigo_produto_erp: 'B9', descricao: 'FILTRO DA EMPRESA B', marca: null, unidade: 'UN' }] })
    })

    const a = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })
    const b = await service.consultarProdutos({ company_id: 2, consulta: { busca: 'filtro' } })

    expect(JSON.stringify(a.dados)).not.toContain('EMPRESA B')
    expect(b.dados.outros_com_a_palavra.map((p) => p.codigo_produto_erp)).toEqual(['B9'])
  })

  it('página > 1 revela a continuação da lista sem repetir o exato no topo', async () => {
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('FILTRO'))
      .mockResolvedValueOnce(respostaMultiplos({
        produtos: [{ codigo_produto_erp: 'C1', descricao: 'FILTRO 31', marca: null, unidade: 'UN' }],
        pagina: 2,
        total: 468,
        temMais: true,
        temAnterior: true,
      }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro', pagina: 2 } })

    expect(wmApiClient.consultarProdutos.mock.calls[1][0]).toEqual({ telefone: TELEFONE_A, busca: 'filtr', pagina: 2 })
    expect(r.dados.status).toBe('multiplos_produtos')
    expect(r.dados.correspondencia_exata).toBeUndefined()
    expect(r.dados.produtos.map((p) => p.codigo_produto_erp)).toEqual(['C1'])
    expect(r.dados.paginacao.pagina).toBe(2)
  })

  it('o preço do exato atravessa, e os irmãos continuam sem preço', async () => {
    wmApiClient.consultarProdutos
      .mockResolvedValueOnce(respostaResolvida('FILTRO', { preco_unitario: '0.010', estoque_previsto: '0.000', ativo: true }))
      .mockResolvedValueOnce(respostaMultiplos({ produtos: IRMAOS, meta: { fonte: 'cache_cloud' } }))

    const r = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'filtro' } })

    expect(r.dados.correspondencia_exata.preco_unitario).toBe('0.010')
    // A procedência do preço é a da PRIMEIRA resposta, não a da lista.
    expect(r.dados.correspondencia_exata_meta.fonte).toBe('tempo_real')
    expect(r.dados.meta.fonte).toBe('cache_cloud')
    for (const outro of r.dados.outros_com_a_palavra) {
      expect(outro.preco_unitario).toBeUndefined()
    }
  })
})

// =============================================================================
// Segredos
// =============================================================================
describe('segredos', () => {
  it('nem telefone nem token aparecem em log, resposta ou erro', async () => {
    process.env.ZAPERP_API_TOKEN = 'zaperp_tok_NUNCA_LOGAR'
    const espioes = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}))

    wmApiClient.consultarProdutos.mockResolvedValueOnce(respostaMultiplos({
      produtos: [{ codigo_produto_erp: '1', descricao: 'A', marca: null, unidade: 'UN' }],
    }))
    const ok = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'chapa' } })

    wmApiClient.consultarProdutos.mockResolvedValueOnce(falhaWm({ status: 403, erroWm: 'CONTATO_NAO_AUTORIZADO' }))
    const erro = await service.consultarProdutos({ company_id: 1, consulta: { busca: 'parafuso' } })

    const tudoLogado = espioes
      .flatMap((e) => e.mock.calls)
      .flat()
      .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      .join(' ')

    for (const texto of [tudoLogado, JSON.stringify(ok), JSON.stringify(erro)]) {
      expect(texto).not.toContain(TELEFONE_A)
      expect(texto).not.toContain('zaperp_tok_NUNCA_LOGAR')
    }
    // O 403 é ambíguo por desenho: a mensagem não afirma a causa nem cita telefone.
    expect(erro.envelope.mensagem).not.toMatch(/telefone|contato autorizado/i)

    espioes.forEach((e) => e.mockRestore())
    delete process.env.ZAPERP_API_TOKEN
  })
})
