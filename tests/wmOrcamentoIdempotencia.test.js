/**
 * Idempotência e concorrência do orçamento WM — Sessões 4A e 6 do doc 36, seção 7.
 *
 * É o arquivo que importa mais nesta frente: o erro que ele previne é irreversível. Um
 * orçamento duplicado no ERP de terceiro não se desfaz com um `UPDATE`.
 *
 * Desde a Sessão 6 `confirmar` DESPACHA de verdade — e por isso cada asserção aqui deixou de
 * falar de um despacho simulado e passou a contar chamadas reais ao `wmApiClient` (mockado;
 * nenhum teste desta suíte faz rede, e o `fetch` global é um espião que lança se for tocado).
 *
 * O QUE ESTÁ PROVADO AQUI
 *
 *   · a trava de concorrência é o BANCO — o `UPDATE … WHERE estado='PREPARADO' AND
 *     expira_em > now()` com as 4 condições, inclusive `company_id`;
 *   · duplo clique simultâneo: UMA requisição ganha a transição e o POST de criação sai UMA
 *     vez; as outras recebem o estado atual e não falam com a WM;
 *   · F5 durante `ENVIANDO` **não gera `comando_id` novo** e não redespacha;
 *   · mesmo `comando_id` com `payload_hash` diferente é barrado localmente e **nunca**
 *     despachado;
 *   · `200` idempotente não duplica histórico; `504`, timeout e falha não classificada viram
 *     `INCERTO`; erro de conexão vira `FALHA_SEGURA`;
 *   · `verificar` só aceita `INCERTO`, reusa o MESMO `comando_id` e o MESMO payload, e nunca
 *     transforma um incerto em falha segura (D10);
 *   · o POST de criação **não tem retry**: uma tentativa, com `retryOpts` ausente.
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
const orcamentoWmFlag = require('../helpers/orcamentoWmFlag')
const service = require('../services/wm/wmOrcamentoService')
const stateMachine = require('../services/wm/wmOrcamentoStateMachine')
const { mapearErroWm, OPERACAO } = require('../helpers/wmErrorMapper')
const { criarFakeDb } = require('./fixtures/wmOperacoesFakeDb')

const RAIZ = path.join(__dirname, '..')
const TELEFONE_EMPRESA_1 = '5534991847800'
const TELEFONE_EMPRESA_2 = '5511988887777'

const ID_PREPARACAO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ID_OUTRA_EMPRESA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const COMANDO_EXISTENTE = 'cccccccc-3333-4333-8333-cccccccccccc'

const PAYLOAD_CRIACAO = Object.freeze({
  cliente_codigo_erp: 'C0001',
  vendedor_codigo_erp: 'V0007',
  bloquear_apos_criar: true,
  itens: [{ codigo_produto_erp: 'P001', quantidade: '2', preco_confirmado: '33.038' }],
})

let db
let fetchEspiao

/** Linha de operação com o hash coerente com o payload (o caso saudável). */
function linha(patch = {}) {
  const payload_criacao = patch.payload_criacao || { ...PAYLOAD_CRIACAO }
  return {
    id: ID_PREPARACAO,
    company_id: 1,
    usuario_id: 9,
    conversa_id: 501,
    estado: 'PREPARADO',
    comando_id: null,
    payload_criacao,
    payload_hash: stateMachine.calcularPayloadHash(payload_criacao),
    previa_sanitizada: { total: '66.076' },
    wm_resultado_sanitizado: null,
    http_status_ultimo: null,
    erro_codigo_ultimo: null,
    tentativas: 0,
    expira_em: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    enviado_em: null,
    concluido_em: null,
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
    ...patch,
  }
}

/** `200` realista de `/orcamentos/criar` (§10 do guia da 2ª remessa). */
const CRIACAO_200 = Object.freeze({
  ok: true,
  status: 200,
  operacao: 'criacao',
  data: {
    dados: {
      codigo_pedido_erp: '123456',
      documento_venda: '2 - Orçamento',
      cliente: { codigo_cliente_erp: 'C0001', nome: 'Maria Souza' },
      vendedor: { codigo_vendedor_erp: 'V0007', nome: 'Carlos Lima' },
      valor_total: '66.076',
      bloqueado: true,
    },
    meta: { fonte: 'tempo_real', criado_em: '2026-10-21T10:00:00' },
  },
})

/** Resposta de erro do `wmApiClient` (ele nunca lança; sempre devolve este formato). */
function respostaErro(patch = {}) {
  return {
    ok: false,
    status: 0,
    data: null,
    erroWm: null,
    indiceItem: null,
    transporte: null,
    respostaInvalida: false,
    configuracaoInvalida: null,
    operacao: 'criacao',
    ...patch,
  }
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  fetchEspiao = jest.fn(() => { throw new Error('nenhum teste pode fazer rede real') })
  global.fetch = fetchEspiao

  db = criarFakeDb({ linhas: [linha()] })
  usuarioTemPermissao.mockResolvedValue(true)
  configService.obterConfigInterna.mockImplementation(async (cid) => {
    const mapa = { 1: TELEFONE_EMPRESA_1, 2: TELEFONE_EMPRESA_2 }
    const telefone = mapa[Number(cid)]
    if (!telefone) return null
    return { company_id: Number(cid), ativo: true, telefone_autorizado: telefone, atualizado_em: '2026-10-20T12:00:00.000Z' }
  })
  wmApiClient.criarOrcamento.mockResolvedValue({ ...CRIACAO_200 })
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

// =============================================================================
// 1. A transição atômica
// =============================================================================
describe('transição atômica PREPARADO → ENVIANDO', () => {
  it('leva as 4 condições do SQL da seção 7, inclusive company_id', async () => {
    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    // Com o despacho ligado o estado final já é CRIADO; o que este teste examina é a transição
    // intermediária, que é onde mora a trava.
    expect(r.resultado.estado).toBe('CRIADO')

    const update = db.chamadas.find((c) => c.modo === 'update' && c.patch?.estado === 'ENVIANDO')
    expect(update).toBeTruthy()
    const filtros = update.filtros.map(([op, col]) => `${op}:${col}`)
    expect(filtros).toEqual(expect.arrayContaining(['eq:id', 'eq:company_id', 'eq:estado', 'gt:expira_em']))
    expect(update.patch.comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(update.patch.enviado_em).toBeTruthy()
  })

  it('o comando_id é gerado pelo backend e persistido ANTES do despacho', async () => {
    // A ordem é a garantia: se o POST saísse antes do UPDATE, um crash no meio deixaria um
    // orçamento no ERP sem rastro nenhum do lado de cá.
    let comandoNoBancoQuandoOPostSaiu = null
    let estadoNoBancoQuandoOPostSaiu = null
    wmApiClient.criarOrcamento.mockImplementation(async () => {
      comandoNoBancoQuandoOPostSaiu = db.operacoes[0].comando_id
      estadoNoBancoQuandoOPostSaiu = db.operacoes[0].estado
      return { ...CRIACAO_200 }
    })

    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    // No instante do POST o comando já estava gravado, e a linha já estava em ENVIANDO.
    expect(comandoNoBancoQuandoOPostSaiu).toMatch(/^[0-9a-f-]{36}$/)
    expect(estadoNoBancoQuandoOPostSaiu).toBe('ENVIANDO')
    // E o que foi despachado é o MESMO comando — não um segundo UUID.
    expect(wmApiClient.criarOrcamento.mock.calls[0][0].comando_id).toBe(comandoNoBancoQuandoOPostSaiu)
  })

  it('o comando_id NUNCA sai na resposta ao navegador', async () => {
    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    const comandoDespachado = wmApiClient.criarOrcamento.mock.calls[0][0].comando_id
    const corpo = JSON.stringify(r.resultado)
    expect(corpo).not.toContain(comandoDespachado)
    expect(corpo).not.toMatch(/comando_id/i)
    expect(corpo).not.toMatch(/payload_hash/i)
    expect(corpo).not.toContain(TELEFONE_EMPRESA_1)
    expect(r.resultado.despachado).toBe(true)
  })

  it('o payload despachado carrega o telefone da empresa e o preço do SNAPSHOT', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
    const payload = wmApiClient.criarOrcamento.mock.calls[0][0]
    expect(payload.telefone).toBe(TELEFONE_EMPRESA_1)
    expect(payload.cliente_codigo_erp).toBe('C0001')
    expect(payload.itens[0].preco_confirmado).toBe('33.038')
    // `preparar` não é chamado por `confirmar` em nenhuma hipótese.
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('o 200 vira CRIADO com o número do ERP, concluido_em e tentativas = 1', async () => {
    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(r.resultado.estado).toBe('CRIADO')
    expect(r.resultado.resultado.codigo_pedido_erp).toBe('123456')
    expect(r.resultado.ja_criado).toBe(false)

    const linha = db.operacoes[0]
    expect(linha.estado).toBe('CRIADO')
    expect(linha.wm_resultado_sanitizado.codigo_pedido_erp).toBe('123456')
    expect(linha.concluido_em).toBeTruthy()
    expect(linha.http_status_ultimo).toBe(200)
    expect(linha.erro_codigo_ultimo).toBeNull()
    // A coluna existia desde a migration e nunca tinha sido escrita.
    expect(linha.tentativas).toBe(1)
  })

  it('200 sem `codigo_pedido_erp` utilizável é INCERTO — nunca CRIADO sem número', async () => {
    wmApiClient.criarOrcamento.mockResolvedValue({
      ...CRIACAO_200,
      data: { dados: { documento_venda: '2 - Orçamento' }, meta: {} },
    })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(db.operacoes[0].estado).toBe('INCERTO')
    expect(db.operacoes[0].wm_resultado_sanitizado).toBeNull()
    expect(db.operacoes[0].concluido_em).toBeNull()
  })
})

// =============================================================================
// 2. Duplo clique / duas abas
// =============================================================================
describe('concorrência: duplo clique simultâneo', () => {
  it('duas confirmações ao mesmo tempo: UMA ganha, e o despacho sai UMA vez', async () => {
    const [a, b] = await Promise.all([
      service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
      service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
    ])

    // Nenhuma das duas é erro: a perdedora recebe o estado atual, não uma falha.
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const vencedoras = [a, b].filter((r) => !r.resultado.ja_em_andamento)
    const perdedoras = [a, b].filter((r) => r.resultado.ja_em_andamento)
    expect(vencedoras).toHaveLength(1)
    expect(perdedoras).toHaveLength(1)
    expect(perdedoras[0].resultado.estado).toBe('ENVIANDO')

    // Um comando_id no banco, e o despacho condicionado à transição saiu exatamente uma vez.
    expect(db.operacoes).toHaveLength(1)
    expect(db.operacoes[0].comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('cinco confirmações simultâneas também produzem um único comando e um único despacho', async () => {
    const todas = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
      )
    )

    expect(todas.filter((r) => r.ok && !r.resultado.ja_em_andamento)).toHaveLength(1)
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
    const comandos = new Set(db.operacoes.map((o) => o.comando_id))
    expect(comandos.size).toBe(1)
  })

  it('o UUID que a requisição perdedora gerou nunca é persistido', async () => {
    const [a, b] = await Promise.all([
      service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
      service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
    ])
    expect([a, b].filter((r) => r.resultado.ja_em_andamento)).toHaveLength(1)

    // Duas tentativas de UPDATE com comando_id diferente foram emitidas...
    const tentativas = db.chamadas.filter((c) => c.modo === 'update' && c.patch?.comando_id)
    expect(tentativas.length).toBeGreaterThanOrEqual(2)
    const distintos = new Set(tentativas.map((c) => c.patch.comando_id))
    expect(distintos.size).toBeGreaterThanOrEqual(2)
    // ...e só um sobreviveu na linha, porque a condição `estado='PREPARADO'` barrou o outro.
    expect(distintos.has(db.operacoes[0].comando_id)).toBe(true)
  })
})

// =============================================================================
// 3. F5 durante ENVIANDO
// =============================================================================
describe('F5 durante ENVIANDO não gera comando novo', () => {
  beforeEach(() => {
    db = criarFakeDb({
      linhas: [linha({ estado: 'ENVIANDO', comando_id: COMANDO_EXISTENTE, enviado_em: new Date().toISOString() })],
    })
  })

  it('devolve o mesmo estado, mantém o comando_id e não chama a WM', async () => {
    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(r.resultado.estado).toBe('ENVIANDO')
    expect(r.resultado.ja_em_andamento).toBe(true)
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('nenhum UPDATE com comando_id novo é aplicado à linha', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    // Com a linha já em ENVIANDO, nem se tenta a transição: não há UPDATE de comando.
    expect(db.chamadas.filter((c) => c.modo === 'update' && c.patch?.comando_id)).toHaveLength(0)
  })

  it('CRIADO responde idempotente, sem novo comando e sem despacho', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'CRIADO', comando_id: COMANDO_EXISTENTE, concluido_em: new Date().toISOString() })] })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(r.resultado.estado).toBe('CRIADO')
    expect(r.resultado.ja_criado).toBe(true)
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 4. Expiração
// =============================================================================
describe('preparação expirada não vira gravação', () => {
  it('prazo local vencido é 409 e a linha passa a EXPIRADO, sem comando_id', async () => {
    db = criarFakeDb({ linhas: [linha({ expira_em: new Date(Date.now() - 1000).toISOString() })] })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(409)
    expect(r.envelope.codigo).toBe('ORCAMENTO_PREPARACAO_EXPIRADA')
    expect(db.operacoes[0].estado).toBe('EXPIRADO')
    expect(db.operacoes[0].comando_id).toBeNull()
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('linha já EXPIRADO é 409 e continua sem comando_id', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'EXPIRADO' })] })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('ORCAMENTO_PREPARACAO_EXPIRADA')
    expect(db.operacoes[0].comando_id).toBeNull()
  })

  it('o filtro gt:expira_em usa o instante da requisição (a trava não depende da leitura)', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    const update = db.chamadas.find((c) => c.modo === 'update' && c.patch?.estado === 'ENVIANDO')
    const filtro = update.filtros.find(([op, col]) => op === 'gt' && col === 'expira_em')
    expect(Number.isFinite(Date.parse(filtro[2]))).toBe(true)
  })

  it('snapshot sem hash não é confirmável', async () => {
    db = criarFakeDb({ linhas: [linha({ payload_hash: null })] })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('ORCAMENTO_SNAPSHOT_AUSENTE')
    expect(db.operacoes[0].comando_id).toBeNull()
  })
})

// =============================================================================
// 5. Mesmo comando_id com payload diferente
// =============================================================================
describe('mesmo comando_id com payload_hash diferente é barrado LOCALMENTE', () => {
  it('montarPayloadDespacho recusa payload adulterado e não devolve payload nenhum', () => {
    const adulterado = { ...PAYLOAD_CRIACAO, itens: [{ ...PAYLOAD_CRIACAO.itens[0], preco_confirmado: '0.010' }] }

    const r = service.montarPayloadDespacho({
      payload_criacao: adulterado,
      payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO), // hash do ORIGINAL
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
    })

    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('ORCAMENTO_SNAPSHOT_DIVERGENTE')
    expect(r.payload).toBeUndefined()
  })

  it.each([
    ['preço', { itens: [{ codigo_produto_erp: 'P001', quantidade: '2', preco_confirmado: '1.000' }] }],
    ['quantidade', { itens: [{ codigo_produto_erp: 'P001', quantidade: '99', preco_confirmado: '33.038' }] }],
    ['produto', { itens: [{ codigo_produto_erp: 'P999', quantidade: '2', preco_confirmado: '33.038' }] }],
    ['cliente', { cliente_codigo_erp: 'C9999' }],
    ['vendedor', { vendedor_codigo_erp: 'V9999' }],
    ['política', { bloquear_apos_criar: false }],
  ])('alterar %s no snapshot muda o hash e barra o despacho', (_campo, mudanca) => {
    const adulterado = { ...PAYLOAD_CRIACAO, ...mudanca }
    expect(stateMachine.calcularPayloadHash(adulterado)).not.toBe(stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO))

    const r = service.montarPayloadDespacho({
      payload_criacao: adulterado,
      payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO),
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
    })
    expect(r.ok).toBe(false)
  })

  it('verificar com snapshot divergente não despacha e devolve 409', async () => {
    const divergente = { ...PAYLOAD_CRIACAO, cliente_codigo_erp: 'C_OUTRO' }
    db = criarFakeDb({
      linhas: [linha({
        estado: 'INCERTO',
        comando_id: COMANDO_EXISTENTE,
        payload_criacao: divergente,
        payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO),
      })],
    })
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(409)
    expect(r.envelope.codigo).toBe('ORCAMENTO_SNAPSHOT_DIVERGENTE')
    expect(r.envelope.estado).toBe('INCERTO')
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    aviso.mockRestore()
  })

  it('o hash é estável para as mesmas chaves em outra ordem (não é um falso positivo)', () => {
    const outraOrdem = {
      itens: [{ preco_confirmado: '33.038', quantidade: '2', codigo_produto_erp: 'P001' }],
      bloquear_apos_criar: true,
      vendedor_codigo_erp: 'V0007',
      cliente_codigo_erp: 'C0001',
    }
    const r = service.montarPayloadDespacho({
      payload_criacao: outraOrdem,
      payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO),
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
    })
    expect(r.ok).toBe(true)
    // O payload do despacho ganha telefone e comando_id, que não vivem no snapshot.
    expect(r.payload.telefone).toBe(TELEFONE_EMPRESA_1)
    expect(r.payload.comando_id).toBe(COMANDO_EXISTENTE)
    expect(r.payload.itens[0].preco_confirmado).toBe('33.038')
  })
})

// =============================================================================
// 6. Timeout vira INCERTO, e INCERTO nunca gera comando novo
// =============================================================================
describe('INCERTO (D10)', () => {
  it('timeout na CRIAÇÃO é mapeado para INCERTO (a fiação de que a 4A depende)', () => {
    const { envelope, interno } = mapearErroWm({
      resultado: { transporte: 'timeout', status: 0 },
      operacao: OPERACAO.CRIACAO,
    })
    expect(envelope.estado).toBe('INCERTO')
    expect(envelope.codigo).toBe('WM_RESULTADO_INCERTO')
    expect(interno.httpStatusLocal).toBe(504)
  })

  it('504 REALTIME_TIMEOUT na criação também é INCERTO; em preparar/leitura é falha segura', () => {
    const criacao = mapearErroWm({ resultado: { status: 504, erroWm: 'REALTIME_TIMEOUT' }, operacao: OPERACAO.CRIACAO })
    expect(criacao.envelope.estado).toBe('INCERTO')

    const preparacao = mapearErroWm({ resultado: { status: 504, erroWm: 'REALTIME_TIMEOUT' }, operacao: OPERACAO.PREPARACAO })
    expect(preparacao.envelope.estado).toBe('FALHA_SEGURA')
  })

  it('a única saída de INCERTO é CRIADO — nunca ENVIANDO, nunca FALHA_SEGURA', () => {
    // Sair para ENVIANDO significaria despachar de novo (com comando novo); sair para
    // FALHA_SEGURA significaria afirmar que o orçamento não existe. Nenhuma das duas é
    // sustentável sobre um incerto.
    expect(stateMachine.proximosEstados('INCERTO')).toEqual(['CRIADO'])
    expect(stateMachine.transicaoPermitida('INCERTO', 'ENVIANDO')).toBe(false)
    expect(stateMachine.transicaoPermitida('INCERTO', 'PREPARADO')).toBe(false)
    expect(stateMachine.transicaoPermitida('INCERTO', 'FALHA_SEGURA')).toBe(false)
    expect(stateMachine.transicaoPermitida('ENVIANDO', 'INCERTO')).toBe(true)
  })

  it('confirmar em cima de um INCERTO é recusado e NÃO gera comando novo', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESULTADO_INCERTO')
    expect(r.envelope.estado).toBe('INCERTO')
    expect(r.envelope.mensagem).toMatch(/não crie outro/i)
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    expect(db.chamadas.filter((c) => c.modo === 'update' && c.patch?.comando_id)).toHaveLength(0)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('verificar reenvia o MESMO comando_id com o MESMO payload, e nunca gera outro', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
    const payload = wmApiClient.criarOrcamento.mock.calls[0][0]
    // O MESMO comando. Um UUID novo aqui seria um segundo orçamento no Icthus.
    expect(payload.comando_id).toBe(COMANDO_EXISTENTE)
    expect(payload).toEqual({
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
      cliente_codigo_erp: 'C0001',
      vendedor_codigo_erp: 'V0007',
      bloquear_apos_criar: true,
      itens: [{ codigo_produto_erp: 'P001', quantidade: '2', preco_confirmado: '33.038' }],
    })
    // 200 na reconciliação: o orçamento já existia e agora sabemos o número.
    expect(r.ok).toBe(true)
    expect(r.resultado.estado).toBe('CRIADO')
    expect(r.resultado.resultado.codigo_pedido_erp).toBe('123456')
    expect(r.resultado.ja_criado).toBe(true)
    expect(r.resultado.reconciliado).toBe(true)
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    // E o comando_id não vaza na resposta.
    expect(JSON.stringify(r.resultado)).not.toContain(COMANDO_EXISTENTE)
  })

  it.each([
    ['COMANDO_NAO_REEXECUTADO', 409],
    ['RESULTADO_INCERTO', 409],
  ])('verificar com 409 %s continua INCERTO (a WM não reexecuta)', async (erroWm, status) => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE, tentativas: 1 })] })
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ status, erroWm }))

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(db.operacoes[0].estado).toBe('INCERTO')
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    // Os metadados entram mesmo sem mudar de estado — é o rastro do runbook.
    expect(db.operacoes[0].tentativas).toBe(2)
    expect(db.operacoes[0].http_status_ultimo).toBe(409)
    expect(db.operacoes[0].erro_codigo_ultimo).toBe(erroWm)
  })

  it('verificar com 409 COMANDO_ID_REUTILIZADO NÃO rebaixa o incerto para falha segura', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ status: 409, erroWm: 'COMANDO_ID_REUTILIZADO' }))

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_COMANDO_ID_REUTILIZADO')
    // Crítico: a WM diz que este comando já foi usado com outro payload. O orçamento PODE
    // existir — chamar isso de falha segura convidaria a criar outro.
    expect(db.operacoes[0].estado).toBe('INCERTO')
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('verificar com falha de rede continua INCERTO e não redespacha', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ transporte: 'timeout' }))

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(db.operacoes[0].estado).toBe('INCERTO')
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('o payload remontado é byte a byte o do snapshot, com o mesmo comando', () => {
    const r = service.montarPayloadDespacho({
      payload_criacao: PAYLOAD_CRIACAO,
      payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO),
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
    })
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({
      telefone: TELEFONE_EMPRESA_1,
      comando_id: COMANDO_EXISTENTE,
      cliente_codigo_erp: 'C0001',
      vendedor_codigo_erp: 'V0007',
      bloquear_apos_criar: true,
      itens: [{ codigo_produto_erp: 'P001', quantidade: '2', preco_confirmado: '33.038' }],
    })
  })

  it('INCERTO sem comando_id persistido para em vez de gerar um', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: null })] })

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('ORCAMENTO_SNAPSHOT_AUSENTE')
    expect(db.operacoes[0].comando_id).toBeNull()
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it.each(['PREPARADO', 'ENVIANDO', 'EXPIRADO', 'FALHA_SEGURA'])('verificar em %s é recusado (só INCERTO é verificável)', async (estado) => {
    db = criarFakeDb({ linhas: [linha({ estado, comando_id: estado === 'PREPARADO' ? null : COMANDO_EXISTENTE })] })

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('ORCAMENTO_ESTADO_INVALIDO')
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('verificar em CRIADO devolve o resultado idempotente sem despachar', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'CRIADO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(r.resultado.ja_criado).toBe(true)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 6B. A tabela de desfechos da seção 7 — FALHA_SEGURA × INCERTO
// =============================================================================
describe('desfecho do despacho: o que cada resposta da WM vira no banco', () => {
  it.each([
    ['504 (REALTIME_TIMEOUT)', { status: 504, erroWm: 'REALTIME_TIMEOUT' }],
    ['504 sem código', { status: 504 }],
    ['timeout de transporte', { transporte: 'timeout' }],
    ['falha de transporte não classificada', { transporte: 'desconhecido' }],
    ['409 COMANDO_NAO_REEXECUTADO', { status: 409, erroWm: 'COMANDO_NAO_REEXECUTADO' }],
    ['409 RESULTADO_INCERTO', { status: 409, erroWm: 'RESULTADO_INCERTO' }],
    ['2xx com corpo fora do contrato', { ok: false, status: 200, respostaInvalida: true }],
  ])('%s ⇒ INCERTO (a escrita pode ter acontecido)', async (_rotulo, patch) => {
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro(patch))

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(r.envelope.mensagem).toMatch(/não crie outro|procure o suporte/i)
    expect(db.operacoes[0].estado).toBe('INCERTO')
    expect(db.operacoes[0].concluido_em).toBeNull()
    expect(db.operacoes[0].tentativas).toBe(1)
  })

  it.each([
    ['erro de CONEXÃO (prova que não chegou)', { transporte: 'conexao' }],
    ['502 (recusa antes da escrita)', { status: 502 }],
    ['503 SINCRONIZADOR_OFFLINE (antes do envio)', { status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }],
    ['400 payload_invalido', { status: 400, erroWm: 'payload_invalido' }],
    ['422 CLIENTE_INVALIDO', { status: 422, erroWm: 'CLIENTE_INVALIDO' }],
    ['409 COMANDO_ID_REUTILIZADO', { status: 409, erroWm: 'COMANDO_ID_REUTILIZADO' }],
  ])('%s ⇒ FALHA_SEGURA (nada foi gravado)', async (_rotulo, patch) => {
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro(patch))

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('FALHA_SEGURA')
    expect(db.operacoes[0].estado).toBe('FALHA_SEGURA')
    expect(db.operacoes[0].concluido_em).toBeNull()
    expect(db.operacoes[0].wm_resultado_sanitizado).toBeNull()
    expect(db.operacoes[0].tentativas).toBe(1)
  })

  it('ORCAMENTO_DADOS_ALTERADOS é FALHA_SEGURA e manda REPREPARAR, não "tentar de novo"', async () => {
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ status: 409, erroWm: 'ORCAMENTO_DADOS_ALTERADOS' }))

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.envelope.codigo).toBe('WM_ORCAMENTO_DADOS_ALTERADOS')
    expect(r.envelope.estado).toBe('FALHA_SEGURA')
    // A frase não pode convidar a repetir o MESMO comando: ele nunca vai passar.
    expect(r.envelope.mensagem).toMatch(/calcule a prévia de novo/i)
    expect(db.operacoes[0].estado).toBe('FALHA_SEGURA')
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('o erro_codigo_ultimo guarda o código da WM — é o que o runbook procura', async () => {
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }))

    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(db.operacoes[0].erro_codigo_ultimo).toBe('SINCRONIZADOR_OFFLINE')
    expect(db.operacoes[0].http_status_ultimo).toBe(503)
  })

  it('a resposta da WM chegou e o nosso UPDATE falhou: INCERTO, nunca sucesso', async () => {
    // O POST só acontece depois da transição atômica, então derrubar o UPDATE de dentro do
    // mock atinge exatamente o registro do desfecho — a situação que o teste quer.
    wmApiClient.criarOrcamento.mockImplementation(async () => {
      db.falhar.update = true
      return { ...CRIACAO_200 }
    })
    const erroLog = jest.spyOn(console, 'error').mockImplementation(() => {})

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(r.envelope.mensagem).toMatch(/procure o suporte/i)
    // O número do orçamento não vive em mais lugar nenhum: tem de estar no log de erro.
    const logado = JSON.stringify(erroLog.mock.calls)
    expect(logado).toMatch(/desfecho do despacho NÃO registrado/)
    expect(logado).toContain('123456')
    erroLog.mockRestore()
  })

  it('UPDATE completo recusado mas o mínimo passa: a linha fica INCERTO (e não CRIADO sem número)', async () => {
    // Um CRIADO sem `wm_resultado_sanitizado` seria um beco: a tela não teria número para
    // mostrar e `verificar` recusaria a operação (só aceita INCERTO). INCERTO é reconciliável.
    const erroLog = jest.spyOn(console, 'error').mockImplementation(() => {})
    // Recusa SÓ o patch que carrega o resultado (jsonb grande, coluna, o que for). O UPDATE
    // mínimo de estado — o degrau de recuperação — continua funcionando.
    const supabase = require('../config/supabase')
    const builderOriginal = supabase.from.getMockImplementation()
    const recusado = {
      eq: () => recusado,
      gt: () => recusado,
      select: () => recusado,
      async maybeSingle() { return { data: null, error: { message: 'patch recusado' } } },
    }
    supabase.from.mockImplementation((tabela) => {
      const chain = builderOriginal(tabela)
      const update = chain.update
      chain.update = (patch) => (patch?.wm_resultado_sanitizado !== undefined ? recusado : update(patch))
      return chain
    })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('INCERTO')
    expect(db.operacoes[0].estado).toBe('INCERTO')
    erroLog.mockRestore()
  })

  it('o 200 idempotente não duplica histórico: operação já CRIADO não redespacha', async () => {
    db = criarFakeDb({
      linhas: [linha({
        estado: 'CRIADO',
        comando_id: COMANDO_EXISTENTE,
        concluido_em: new Date().toISOString(),
        wm_resultado_sanitizado: { codigo_pedido_erp: '123456' },
        tentativas: 1,
      })],
    })

    const a = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    const b = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    for (const r of [a, b]) {
      expect(r.ok).toBe(true)
      expect(r.resultado.estado).toBe('CRIADO')
      expect(r.resultado.ja_criado).toBe(true)
      expect(r.resultado.resultado.codigo_pedido_erp).toBe('123456')
    }
    // Uma linha, uma criação, nenhum POST novo e `tentativas` intacto.
    expect(db.operacoes).toHaveLength(1)
    expect(db.operacoes[0].tentativas).toBe(1)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('configuração de integração ausente vira FALHA_SEGURA sem nenhum POST', async () => {
    configService.obterConfigInterna.mockResolvedValue({ company_id: 1, ativo: false, telefone_autorizado: TELEFONE_EMPRESA_1 })

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.estado).toBe('FALHA_SEGURA')
    expect(db.operacoes[0].estado).toBe('FALHA_SEGURA')
    // Nada saiu: a prova de falha segura é não ter havido chamada.
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    // E a tentativa não contou, porque despacho nenhum foi feito.
    expect(db.operacoes[0].tentativas).toBe(0)
  })

  it('snapshot adulterado barra o despacho e a operação vira FALHA_SEGURA', async () => {
    db = criarFakeDb({
      linhas: [linha({
        payload_criacao: { ...PAYLOAD_CRIACAO, cliente_codigo_erp: 'C_OUTRO' },
        payload_hash: stateMachine.calcularPayloadHash(PAYLOAD_CRIACAO),
      })],
    })
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('ORCAMENTO_SNAPSHOT_DIVERGENTE')
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    expect(db.operacoes[0].estado).toBe('FALHA_SEGURA')
    aviso.mockRestore()
  })
})

// =============================================================================
// 7. Nenhum retry automático
// =============================================================================
describe('nenhum POST tem retry automático', () => {
  it('cada confirmação e cada verificação fazem EXATAMENTE um POST de criação', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)

    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })
    await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(2)

    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it.each([
    ['timeout', { transporte: 'timeout' }],
    ['504', { status: 504 }],
    ['503', { status: 503, erroWm: 'SINCRONIZADOR_OFFLINE' }],
    ['502', { status: 502 }],
    ['conexão', { transporte: 'conexao' }],
  ])('falha de %s na criação NÃO produz uma segunda tentativa', async (_rotulo, patch) => {
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro(patch))

    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    // Uma tentativa. Repetir qualquer uma destas duplicaria orçamento no Icthus.
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('o despacho chama `criarOrcamento` com UM argumento — nunca com retryOpts', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    // `criarOrcamento(payload)` e ponto. Não existe assinatura com opções, e o cliente HTTP
    // depende disso: `retryOpts` ausente ⇒ `maxAttempts = 1` no `fetchWithRetry`.
    expect(wmApiClient.criarOrcamento.mock.calls[0]).toHaveLength(1)
  })

  it('o serviço não contém laço de retentativa, e chama a criação num ponto só', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'services/wm/wmOrcamentoService.js'), 'utf8')
    // Nenhum `for`/`while` envolvendo chamada ao cliente WM, nenhum setTimeout de backoff.
    expect(src).not.toMatch(/setTimeout/)
    expect(src).not.toMatch(/while\s*\(/)

    const chamadasEmCodigo = src
      .split('\n')
      .filter((l) => /wmApiClient\.criarOrcamento\s*\(/.test(l))
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    // UMA chamada no arquivo inteiro: `confirmar` e `verificar` passam os dois pelo mesmo
    // ponto. Duas chamadas seriam duas políticas de retry para manter sincronizadas.
    expect(chamadasEmCodigo).toHaveLength(1)
    // E ela passa só o payload: qualquer segundo argumento religa o retry.
    expect(chamadasEmCodigo[0]).toMatch(/criarOrcamento\(\s*montado\.payload\s*\)/)
  })
})

// =============================================================================
// 8. Isolamento entre empresas
// =============================================================================
describe('isolamento: a preparação da empresa A não existe para a empresa B', () => {
  it('empresa B confirmando o UUID da empresa A recebe 404 e não toca na linha', async () => {
    const r = await service.confirmar({ company_id: 2, usuario_id: 77, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    // 404, não 403: um 403 confirmaria que o UUID existe em algum lugar.
    expect(r.httpStatus).toBe(404)
    expect(r.envelope.codigo).toBe('ORCAMENTO_PREPARACAO_NAO_ENCONTRADA')
    expect(db.operacoes[0].estado).toBe('PREPARADO')
    expect(db.operacoes[0].comando_id).toBeNull()
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('empresa B verificando o INCERTO da empresa A recebe 404', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.verificar({ company_id: 2, usuario_id: 77, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(404)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('empresa B lendo a operação da empresa A recebe 404', async () => {
    const r = await service.obterOperacao({ company_id: 2, operacao_id: ID_PREPARACAO })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(404)
  })

  it('duas empresas com preparações distintas não se cruzam', async () => {
    db = criarFakeDb({
      linhas: [linha(), linha({ id: ID_OUTRA_EMPRESA, company_id: 2, usuario_id: 77 })],
    })

    const a = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    const b = await service.confirmar({ company_id: 2, usuario_id: 77, preparacao_id: ID_OUTRA_EMPRESA })

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const linhaA = db.operacoes.find((o) => o.id === ID_PREPARACAO)
    const linhaB = db.operacoes.find((o) => o.id === ID_OUTRA_EMPRESA)
    expect(linhaA.comando_id).not.toBe(linhaB.comando_id)
    expect(linhaA.company_id).toBe(1)
    expect(linhaB.company_id).toBe(2)
  })

  it('toda query de confirmar/verificar/obter carrega company_id', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    await service.obterOperacao({ company_id: 1, operacao_id: ID_PREPARACAO })

    const daTabela = db.chamadas.filter((c) => c.tabela === 'wm_orcamento_operacoes')
    expect(daTabela.length).toBeGreaterThan(0)
    for (const c of daTabela) {
      expect(c.filtros.some(([op, col]) => op === 'eq' && col === 'company_id')).toBe(true)
    }
  })

  it('UUID malformado e company_id inválido não viram leitura nem escrita', async () => {
    for (const id of ['', 'nao-e-uuid', '../../etc', '1 OR 1=1']) {
      const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: id })
      expect(r.ok).toBe(false)
      expect(r.httpStatus).toBe(404)
    }
    for (const cid of [undefined, null, 0, -1, 'x']) {
      const r = await service.confirmar({ company_id: cid, usuario_id: 9, preparacao_id: ID_PREPARACAO })
      expect(r.ok).toBe(false)
    }
    expect(db.chamadas).toHaveLength(0)
    expect(db.operacoes[0].comando_id).toBeNull()
  })
})

// =============================================================================
// 9. Leitura da operação
// =============================================================================
describe('GET da operação não vaza segredo', () => {
  it('não devolve comando_id, payload_criacao nem payload_hash', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'ENVIANDO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.obterOperacao({ company_id: 1, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(Object.keys(r.resultado).sort()).toEqual([
      'concluido_em', 'conversa_id', 'criado_em', 'enviado_em', 'erro_codigo',
      'estado', 'expira_em', 'operacao_id', 'previa', 'resultado', 'tentativas',
    ])
    const corpo = JSON.stringify(r.resultado)
    expect(corpo).not.toContain(COMANDO_EXISTENTE)
    expect(corpo).not.toContain('C0001')
    expect(corpo).not.toContain(TELEFONE_EMPRESA_1)
  })

  it('a leitura comum nem seleciona payload_criacao do banco', async () => {
    await service.obterOperacao({ company_id: 1, operacao_id: ID_PREPARACAO })
    const select = db.chamadas.find((c) => c.modo === 'select')
    expect(select.colunas).not.toContain('payload_criacao')
  })
})

// =============================================================================
// 10. HTTP: cadeia de rota, limiter e permissão
// =============================================================================
describe('rotas de confirmar/verificar/obter (HTTP)', () => {
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

  it('as três rotas estão montadas e fechadas com a flag desligada (403, não 404)', async () => {
    delete process.env.WM_ORCAMENTOS_ENABLED
    const confirmar = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send({})
    const verificar = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/verificar`).set('Authorization', `Bearer ${token()}`).send({})
    const obter = await request(app).get(`/api/orcamentos/${ID_PREPARACAO}`).set('Authorization', `Bearer ${token()}`)

    for (const res of [confirmar, verificar, obter]) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    }
    expect(db.operacoes[0].comando_id).toBeNull()
  })

  it('confirmar exige orcamentos.criar (não basta orcamentos.ver)', async () => {
    ligarModulo()
    usuarioTemPermissao.mockImplementation(async ({ permissao_codigo }) => permissao_codigo === 'orcamentos.ver')

    const res = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(403)
    expect(res.body.permissao).toBe('orcamentos.criar')
    expect(db.operacoes[0].comando_id).toBeNull()
  })

  it('verificar exige orcamentos.criar; obter aceita orcamentos.ver', async () => {
    ligarModulo()
    usuarioTemPermissao.mockImplementation(async ({ permissao_codigo }) => permissao_codigo === 'orcamentos.ver')

    const verificar = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/verificar`).set('Authorization', `Bearer ${token()}`).send({})
    expect(verificar.status).toBe(403)

    const obter = await request(app).get(`/api/orcamentos/${ID_PREPARACAO}`).set('Authorization', `Bearer ${token()}`)
    expect(obter.status).toBe(200)
    expect(obter.body.estado).toBe('PREPARADO')
  })

  it('confirmar com corpo é 400 — o estado todo está no servidor', async () => {
    ligarModulo()
    for (const corpo of [{ preco_confirmado: '0.01' }, { comando_id: COMANDO_EXISTENTE }, { qualquer: 1 }]) {
      const res = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send(corpo)
      expect(res.status).toBe(400)
      expect(res.body.codigo).toBe('ORCAMENTO_DADOS_INVALIDOS')
    }
    expect(db.operacoes[0].comando_id).toBeNull()
  })

  it('caminho comum do confirmar: 200 CRIADO, com o número do ERP e sem comando_id', async () => {
    ligarModulo()

    const res = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('CRIADO')
    expect(res.body.despachado).toBe(true)
    expect(res.body.resultado.codigo_pedido_erp).toBe('123456')
    expect(JSON.stringify(res.body)).not.toMatch(/comando_id/i)
    expect(JSON.stringify(res.body)).not.toContain(TELEFONE_EMPRESA_1)
    expect(db.operacoes[0].comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(wmApiClient.criarOrcamento).toHaveBeenCalledTimes(1)
  })

  it('INCERTO chega ao navegador como 504 com "não crie outro" — sem código técnico', async () => {
    ligarModulo()
    wmApiClient.criarOrcamento.mockResolvedValue(respostaErro({ transporte: 'timeout' }))

    const res = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(504)
    expect(res.body.estado).toBe('INCERTO')
    expect(res.body.mensagem).toMatch(/não crie outro/i)
    // Nada técnico atravessa para a tela.
    expect(JSON.stringify(res.body)).not.toMatch(/comando_id|payload_hash|504|timeout/i)
    expect(db.operacoes[0].estado).toBe('INCERTO')
  })

  it('UUID malformado na rota é 404 e não encosta no banco', async () => {
    ligarModulo()
    const res = await request(app).post('/api/orcamentos/nao-e-uuid/confirmar').set('Authorization', `Bearer ${token()}`).send({})
    expect(res.status).toBe(404)
    expect(res.body.codigo).toBe('ORCAMENTO_PREPARACAO_NAO_ENCONTRADA')
    expect(db.chamadas).toHaveLength(0)
  })

  it('a rota de confirmar e a de verificar usam o destructiveLimiter já existente (D3)', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes/wmOrcamentosRoutes.js'), 'utf8')
    expect(src).toContain("require('../middleware/rateLimit')")
    expect(src).toMatch(/'\/:preparacaoId\/confirmar',\s*\n?\s*destructiveLimiter/)
    expect(src).toMatch(/'\/:operacaoId\/verificar',\s*\n?\s*destructiveLimiter/)
    // Nenhum limiter novo foi criado.
    expect(src).not.toMatch(/rateLimit\(|express-rate-limit/)
  })
})
