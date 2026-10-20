/**
 * Idempotência e concorrência do orçamento WM — Sessão 4A do doc 36, seção 7.
 *
 * É o arquivo que importa mais nesta frente: o erro que ele previne é irreversível. Um
 * orçamento duplicado no ERP de terceiro não se desfaz com um `UPDATE`.
 *
 * O QUE ESTÁ PROVADO AQUI
 *
 *   · a trava de concorrência é o BANCO — o `UPDATE … WHERE estado='PREPARADO' AND
 *     expira_em > now()` com as 4 condições, inclusive `company_id`;
 *   · duplo clique simultâneo: UMA requisição ganha a transição, e um despacho condicionado a
 *     ela sai UMA vez; as outras recebem o estado atual e não falam com a WM;
 *   · F5 durante `ENVIANDO` **não gera `comando_id` novo**;
 *   · mesmo `comando_id` com `payload_hash` diferente é barrado localmente e **nunca**
 *     despachado;
 *   · timeout na criação vira `INCERTO`, `INCERTO` é terminal e **nunca** gera `comando_id`
 *     novo — verificar é reenviar o payload idêntico com o mesmo comando (D10);
 *   · nenhum POST tem retry automático, e nesta sessão **nenhum POST de criação sai**.
 *
 * ⚠️ Nesta sessão `confirmar` NÃO despacha para a WM (o despacho é a Sessão 6). Vários testes
 * abaixo simulam o despacho da Sessão 6 condicionando-o à
 * transição atômica — é assim que se prova hoje que ela basta.
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

/**
 * Despacho da Sessão 6, simulado: só sai quando `confirmar` devolveu a transição vencedora.
 * É o mesmo acoplamento que a Sessão 6 vai ter — e é o que torna "a WM é chamada uma vez"
 * verificável hoje, com a criação ainda bloqueada.
 */
async function confirmarEDespacharComoSessao6(args) {
  const r = await service.confirmar(args)
  const venceu = r.ok && r.resultado?.estado === 'ENVIANDO' && !r.resultado?.ja_em_andamento
  if (venceu) await wmApiClient.criarOrcamento({ simulado: true })
  return r
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
  wmApiClient.criarOrcamento.mockResolvedValue({ ok: true, status: 200, data: {}, operacao: 'criacao' })
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
    expect(r.resultado.estado).toBe('ENVIANDO')

    const update = db.chamadas.find((c) => c.modo === 'update' && c.patch?.estado === 'ENVIANDO')
    expect(update).toBeTruthy()
    const filtros = update.filtros.map(([op, col]) => `${op}:${col}`)
    expect(filtros).toEqual(expect.arrayContaining(['eq:id', 'eq:company_id', 'eq:estado', 'gt:expira_em']))
    expect(update.patch.comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(update.patch.enviado_em).toBeTruthy()
  })

  it('o comando_id é gerado pelo backend e persistido ANTES de qualquer despacho', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    // Persistido na própria transição (que é o único lugar onde ele é escrito).
    expect(db.operacoes[0].comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(db.operacoes[0].estado).toBe('ENVIANDO')
    // E nada foi despachado nesta sessão.
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('o comando_id NUNCA sai na resposta ao navegador', async () => {
    const r = await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    const corpo = JSON.stringify(r.resultado)
    expect(corpo).not.toContain(db.operacoes[0].comando_id)
    expect(corpo).not.toMatch(/comando_id/i)
    expect(corpo).not.toMatch(/payload_hash/i)
    expect(corpo).not.toContain(TELEFONE_EMPRESA_1)
    // A sessão é explícita sobre não ter despachado.
    expect(r.resultado.despachado).toBe(false)
    expect(r.resultado.despacho_pendente_sessao).toBe(6)
  })

  it('confirmar não fala com a WM nesta sessão — nem preparar, nem criar', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 2. Duplo clique / duas abas
// =============================================================================
describe('concorrência: duplo clique simultâneo', () => {
  it('duas confirmações ao mesmo tempo: UMA ganha, e o despacho sai UMA vez', async () => {
    const [a, b] = await Promise.all([
      confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
      confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO }),
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
        confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
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
    const r = await confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

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

    const r = await confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

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

    const r = await confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

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

  it('INCERTO é terminal na máquina de estados — não há saída para ENVIANDO', () => {
    expect(stateMachine.isTerminal('INCERTO')).toBe(true)
    expect(stateMachine.proximosEstados('INCERTO')).toEqual([])
    expect(stateMachine.transicaoPermitida('INCERTO', 'ENVIANDO')).toBe(false)
    expect(stateMachine.transicaoPermitida('ENVIANDO', 'INCERTO')).toBe(true)
  })

  it('confirmar em cima de um INCERTO é recusado e NÃO gera comando novo', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })

    const r = await confirmarEDespacharComoSessao6({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(false)
    expect(r.envelope.codigo).toBe('WM_RESULTADO_INCERTO')
    expect(r.envelope.estado).toBe('INCERTO')
    expect(r.envelope.mensagem).toMatch(/não crie outro/i)
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    expect(db.chamadas.filter((c) => c.modo === 'update' && c.patch?.comando_id)).toHaveLength(0)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
  })

  it('verificar reusa o MESMO comando_id, remonta o payload idêntico e não despacha nesta sessão', async () => {
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })

    const r = await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(r.ok).toBe(true)
    expect(r.resultado.estado).toBe('INCERTO')
    expect(r.resultado.payload_pronto).toBe(true)
    expect(r.resultado.despachado).toBe(false)
    expect(r.resultado.despacho_pendente_sessao).toBe(6)
    // Nenhum comando novo, nem no banco nem em tentativa de UPDATE.
    expect(db.operacoes[0].comando_id).toBe(COMANDO_EXISTENTE)
    expect(db.chamadas.filter((c) => c.modo === 'update')).toHaveLength(0)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    // E o comando_id não vaza na resposta.
    expect(JSON.stringify(r.resultado)).not.toContain(COMANDO_EXISTENTE)
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
// 7. Nenhum retry automático
// =============================================================================
describe('nenhum POST tem retry automático', () => {
  it('nenhuma chamada desta sessão repete, e a criação não é chamada em lugar nenhum do serviço', async () => {
    await service.confirmar({ company_id: 1, usuario_id: 9, preparacao_id: ID_PREPARACAO })
    db = criarFakeDb({ linhas: [linha({ estado: 'INCERTO', comando_id: COMANDO_EXISTENTE })] })
    await service.verificar({ company_id: 1, usuario_id: 9, operacao_id: ID_PREPARACAO })

    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
    expect(wmApiClient.prepararOrcamento).not.toHaveBeenCalled()
  })

  it('o serviço não contém laço de retentativa sobre as chamadas da WM', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'services/wm/wmOrcamentoService.js'), 'utf8')
    // Nenhum `for`/`while` envolvendo chamada ao cliente WM, nenhum setTimeout de backoff.
    expect(src).not.toMatch(/setTimeout/)
    expect(src).not.toMatch(/while\s*\(/)
    // E `criarOrcamento` não é chamado nesta sessão (o despacho é a Sessão 6). A menção em
    // comentário é esperada — é onde a Sessão 6 entra; o que não pode existir é código.
    const chamadasEmCodigo = src
      .split('\n')
      .filter((l) => /wmApiClient\.criarOrcamento\s*\(/.test(l))
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    expect(chamadasEmCodigo).toEqual([])
  })
})

// =============================================================================
// 8. Isolamento entre empresas
// =============================================================================
describe('isolamento: a preparação da empresa A não existe para a empresa B', () => {
  it('empresa B confirmando o UUID da empresa A recebe 404 e não toca na linha', async () => {
    const r = await confirmarEDespacharComoSessao6({ company_id: 2, usuario_id: 77, preparacao_id: ID_PREPARACAO })

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

  it('caminho comum do confirmar: 200 ENVIANDO, sem comando_id na resposta e sem despacho', async () => {
    ligarModulo()

    const res = await request(app).post(`/api/orcamentos/${ID_PREPARACAO}/confirmar`).set('Authorization', `Bearer ${token()}`).send({})

    expect(res.status).toBe(200)
    expect(res.body.estado).toBe('ENVIANDO')
    expect(res.body.despachado).toBe(false)
    expect(JSON.stringify(res.body)).not.toMatch(/comando_id/i)
    expect(db.operacoes[0].comando_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(wmApiClient.criarOrcamento).not.toHaveBeenCalled()
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
