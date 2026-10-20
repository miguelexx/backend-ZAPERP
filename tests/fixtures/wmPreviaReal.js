'use strict'

/**
 * Fixtures da preparação e da criação de orçamento — **shape REAL documentado pela WM**.
 *
 * Substitui `wmPreviaProvisoria.js` (Sessão 4A), que era uma hipótese de forma porque o
 * `openapi.yaml` não modelava a prévia. A 2ª remessa do contrato (20/10/2026) fechou as
 * pendências 1 e 2: o guia
 * `docs/wm/Integracao-ZapERP-API-WM-Atualizacao-2026-10-20.txt` publica em §8 o shape da
 * prévia `pronto_para_confirmacao`, em §9.2 o mapeamento obrigatório prévia → criação e em
 * §10 o shape do `200` de `/orcamentos/criar`.
 *
 * `previaDocumentada()` e `criacaoDocumentada()` são os dois exemplos do guia copiados
 * **byte a byte**, incluindo os valores (`0000108`, `0000474`, `28.900`, `0000045979`). Eles
 * existem para que uma mudança futura do contrato quebre um teste em vez de passar calada.
 *
 * O que o contrato fixa e por isso está fixado aqui:
 *   · preço é STRING `0.00##` invariant (`28.900`, `33.038`) e vai copiado byte a byte de
 *     `dados.itens[].preco_unitario` para `itens[].preco_confirmado` (§8.1 e §9.2);
 *   · quantidade é STRING decimal nas duas chamadas, e a prévia devolve `"2.000"` mesmo
 *     quando enviamos `"2"` — a criação usa a da PRÉVIA;
 *   · `estoque_previsto` é `0.000` invariant e **pode ser negativo** (`-2.125`);
 *   · os itens da prévia correspondem por ÍNDICE aos itens enviados (`indice_item` é "índice
 *     zero-based no array itens enviado").
 */

/** Preços escolhidos para falhar se alguém passar por `Number`: 3 decimais e zero à direita. */
const PRECO_TRES_DECIMAIS = '33.038'
const PRECO_ZERO_A_DIREITA = '1200.500'

/**
 * Prévia pronta, no shape de §8 do guia. `dados` plano: cliente e vendedor em objetos
 * canônicos, itens em `dados.itens`, totais em `dados.valor_produtos`/`dados.valor_total`.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.itens] itens da prévia (campos já no nome do contrato)
 * @param {boolean} [opts.bloquear_apos_criar] o que a WM ecoa (normalmente o que enviamos)
 * @param {string|null} [opts.fonte] `meta.fonte`; `null` omite o `meta` inteiro
 */
function previaPronta({ itens, bloquear_apos_criar = true, fonte = 'tempo_real' } = {}) {
  const lista = itens || [
    { codigo: 'P001', quantidade: '2.000', preco: PRECO_TRES_DECIMAIS, descricao: 'NOTEBOOK LENOVO IDEAPAD', estoque_previsto: '10.000', valor_total: '66.076' },
    { codigo: 'P002', quantidade: '1.000', preco: PRECO_ZERO_A_DIREITA, descricao: 'MONITOR 24', estoque_previsto: '-2.125', valor_total: '1200.500' },
  ]
  const resposta = {
    dados: {
      status: 'pronto_para_confirmacao',
      cliente: { codigo_cliente_erp: 'C0001', nome: 'JOAO DA SILVA', cpf: '123.456.789-00', cnpj: null, inscricao_estadual: 'ISENTO' },
      vendedor: { codigo_vendedor_erp: 'V0007', nome: 'CARLOS SOUZA' },
      itens: lista.map((i) => ({
        codigo_produto_erp: i.codigo,
        descricao: i.descricao ?? null,
        quantidade: i.quantidade,
        preco_unitario: i.preco,
        estoque_previsto: i.estoque_previsto ?? null,
        valor_total: i.valor_total ?? null,
      })),
      valor_produtos: '1266.576',
      valor_total: '1266.576',
      bloquear_apos_criar,
    },
  }
  if (fonte !== null) resposta.meta = { fonte }
  return resposta
}

/** §8 do guia, copiado byte a byte. Um item, com os valores de homologação da própria WM. */
function previaDocumentada() {
  return {
    dados: {
      status: 'pronto_para_confirmacao',
      cliente: { codigo_cliente_erp: '0000108', nome: 'JOAO DA SILVA' },
      vendedor: { codigo_vendedor_erp: '001', nome: 'VENDEDOR TESTE' },
      itens: [
        {
          codigo_produto_erp: '0000474',
          descricao: 'PRODUTO TESTE',
          quantidade: '2.000',
          preco_unitario: '28.900',
          estoque_previsto: '10.000',
          valor_total: '57.80',
        },
      ],
      valor_produtos: '57.80',
      valor_total: '57.80',
      bloquear_apos_criar: true,
    },
    meta: { fonte: 'tempo_real' },
  }
}

/** §10 do guia, copiado byte a byte: o `200` de `/orcamentos/criar`. */
function criacaoDocumentada() {
  return {
    dados: {
      codigo_pedido_erp: '0000045979',
      documento_venda: '2 - Orçamento',
      cliente: { codigo_cliente_erp: '0000108', nome: 'JOAO DA SILVA' },
      vendedor: { codigo_vendedor_erp: '001', nome: 'VENDEDOR TESTE' },
      valor_total: '57.80',
      bloqueado: true,
    },
    meta: { fonte: 'tempo_real', criado_em: '2026-10-20T15:40:00' },
  }
}

/** Ambiguidade de cliente (`CandidatoCliente` — totalmente modelado no `openapi.yaml`). */
function ambiguidadeCliente({ pagina = 1, total = 94, tem_mais = true, tem_anterior = false, candidatos } = {}) {
  return {
    dados: {
      status: 'multiplos_clientes',
      paginacao: { pagina, tamanho_pagina: 30, total, tem_mais, tem_anterior },
      candidatos: candidatos || [
        { codigo_cliente_erp: 'C0001', nome: 'JOAO DA SILVA', cpf: '111.111.111-11', cnpj: null, inscricao_estadual: null },
        { codigo_cliente_erp: 'C0002', nome: 'JOAO DA SILVA FILHO', cpf: null, cnpj: '11.111.111/0001-11', inscricao_estadual: 'ISENTO' },
      ],
    },
    meta: {},
  }
}

/** Ambiguidade de vendedor (`{ codigo_vendedor_erp, nome }`). */
function ambiguidadeVendedor({ pagina = 1, total = 2, tem_mais = false, tem_anterior = false } = {}) {
  return {
    dados: {
      status: 'multiplos_vendedores',
      paginacao: { pagina, tamanho_pagina: 30, total, tem_mais, tem_anterior },
      candidatos: [
        { codigo_vendedor_erp: 'V0007', nome: 'CARLOS SOUZA' },
        { codigo_vendedor_erp: 'V0012', nome: 'CARLOS SOUZA NETO' },
      ],
    },
    meta: {},
  }
}

/**
 * Ambiguidade de produto. `indice_item` é **zero-based** e aponta para o array de itens
 * ENVIADO — os testes usam índice diferente de zero de propósito.
 * Candidatos aqui trazem `preco_unitario`/`estoque_previsto` realtime (ao contrário de
 * `/produtos/consultar`), e o estoque pode ser negativo.
 */
function ambiguidadeProduto({ indice_item = 1, pagina = 1, total = 7, tem_mais = true, tem_anterior = false, candidatos } = {}) {
  return {
    dados: {
      status: 'produto_ambiguo',
      indice_item,
      paginacao: { pagina, tamanho_pagina: 30, total, tem_mais, tem_anterior },
      candidatos: candidatos || [
        { codigo_produto_erp: 'P001', descricao: 'NOTEBOOK LENOVO IDEAPAD', unidade: 'UN', preco_unitario: PRECO_TRES_DECIMAIS, estoque_previsto: '-2.125' },
        { codigo_produto_erp: 'P009', descricao: 'NOTEBOOK DELL INSPIRON', unidade: 'UN', preco_unitario: '4100.000', estoque_previsto: '0.000' },
      ],
    },
    meta: {},
  }
}

/** Resposta 200 crua do `wmApiClient` (que nunca lança: devolve resultado normalizado). */
function resultadoOk(data) {
  return {
    ok: true,
    status: 200,
    operacao: 'preparacao',
    data,
    erroWm: null,
    indiceItem: null,
    transporte: null,
    respostaInvalida: false,
    configuracaoInvalida: null,
    duracaoMs: 12,
  }
}

/** Resposta de erro crua do `wmApiClient`. */
function resultadoErro({ status = 400, erroWm = null, indiceItem = null, transporte = null, respostaInvalida = false } = {}) {
  return {
    ok: false,
    status,
    operacao: 'preparacao',
    data: erroWm ? { erro: erroWm } : null,
    erroWm,
    indiceItem,
    transporte,
    respostaInvalida,
    configuracaoInvalida: null,
    duracaoMs: 9,
  }
}

module.exports = {
  PRECO_TRES_DECIMAIS,
  PRECO_ZERO_A_DIREITA,
  previaPronta,
  previaDocumentada,
  criacaoDocumentada,
  ambiguidadeCliente,
  ambiguidadeVendedor,
  ambiguidadeProduto,
  resultadoOk,
  resultadoErro,
}
