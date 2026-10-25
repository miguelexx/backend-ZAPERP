/**
 * `GET /orcamentos/erp/status` — "dá para orçar agora?".
 *
 * POR QUE ESTA ROTA EXISTE, medido em produção em 25/10/2026 com o sincronizador de uma loja
 * fora do ar: `produtos/consultar` respondeu 200 em 166 ms (acervo dentro da WM) enquanto
 * `clientes/consultar` respondeu 503 em 2478 ms (realtime). A busca de produto funcionando com
 * o resto morto faz o atendente montar a cesta inteira e só descobrir no Calcular.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *   1. indisponibilidade é CONTEÚDO, não erro — a rota responde 200 dizendo que não dá;
 *   2. **404 é loja VIVA** (consultou e não achou), nunca falha — confundir os dois diria
 *      "offline" numa loja saudável;
 *   3. os DOIS vereditos entram no cache de 30 s: o negativo é o caro (2,5 s de timeout) e é
 *      justamente o que não pode ser reapurado a cada abertura de tela;
 *   4. isolamento: empresa A nunca lê o veredito da empresa B;
 *   5. a sonda nunca devolve dado de cliente, mesmo se o código sentinela existir.
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
const servico = require('../services/wm/wmAssistenteService')

const ROTA = '/orcamentos/erp/status'
const ROTA_API = '/api/orcamentos/erp/status'

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

const OFFLINE = { ok: false, status: 503, erroWm: 'SINCRONIZADOR_OFFLINE', transporte: null, data: { erro: 'SINCRONIZADOR_OFFLINE' } }
const NAO_ACHOU = { ok: false, status: 404, erroWm: null, transporte: null, data: {} }
const ACHOU = { ok: true, status: 200, erroWm: null, transporte: null, data: { dados: { status: 'cliente', cliente: { codigo_cliente_erp: '0000000', nome: 'SENTINELA EXISTE' } } } }

function ligarModulo() {
  jest.spyOn(orcamentoWmFlag, 'orcamentoWmHabilitado').mockResolvedValue(true)
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  servico.invalidarDisponibilidadeErp()
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
  wmApiClient.consultarClientes.mockResolvedValue(NAO_ACHOU)
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

/* ================================================================== *
 * 1. Montagem e gate
 * ================================================================== */

describe('rota montada e fechada com a flag desligada', () => {
  it.each([ROTA, ROTA_API])('%s responde 403 de módulo, não 404', async (rota) => {
    const res = await request(app).get(rota).set('Authorization', `Bearer ${token()}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
  })

  it('sem token não passa do auth', async () => {
    const res = await request(app).get(ROTA)
    expect(res.status).toBe(401)
  })
})

/* ================================================================== *
 * 2. Indisponibilidade é conteúdo, não erro
 * ================================================================== */

describe('o veredito vem em 200, inclusive quando é NÃO', () => {
  beforeEach(ligarModulo)

  it('loja offline: 200 com erp_alcancavel false e motivo nomeado', async () => {
    wmApiClient.consultarClientes.mockResolvedValue(OFFLINE)

    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.erp_alcancavel).toBe(false)
    expect(res.body.motivo).toBe('sincronizador_offline')
    expect(typeof res.body.verificado_em).toBe('string')
  })

  it('404 do código sentinela é loja VIVA, não falha', async () => {
    wmApiClient.consultarClientes.mockResolvedValue(NAO_ACHOU)

    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(res.body.erp_alcancavel).toBe(true)
    expect(res.body.motivo).toBeNull()
  })

  it('504 vira "lento", não se confunde com offline', async () => {
    wmApiClient.consultarClientes.mockResolvedValue({ ok: false, status: 504, erroWm: null, transporte: null })
    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
    expect(res.body.motivo).toBe('lento')
  })

  it('empresa sem vínculo é nao_configurado e não chega à WM', async () => {
    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token({ company_id: 3 })}`)

    expect(res.status).toBe(200)
    expect(res.body.erp_alcancavel).toBe(false)
    expect(res.body.motivo).toBe('nao_configurado')
    expect(wmApiClient.consultarClientes).not.toHaveBeenCalled()
  })

  it('exceção de transporte não vaza como erro HTTP', async () => {
    wmApiClient.consultarClientes.mockRejectedValue(new Error('socket hang up'))
    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body.erp_alcancavel).toBe(false)
    expect(res.body.motivo).toBe('indisponivel')
  })
})

/* ================================================================== *
 * 3. A sonda
 * ================================================================== */

describe('a sonda', () => {
  beforeEach(ligarModulo)

  it('pergunta por CÓDIGO, não por nome — igualdade indexada em vez de LIKE com COUNT', async () => {
    await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    const payload = wmApiClient.consultarClientes.mock.calls[0][0]
    expect(payload.codigo_cliente_erp).toBe(servico.CODIGO_SONDA_ERP)
    expect(payload.busca).toBeUndefined()
    expect(payload.telefone).toBe(TELEFONE_EMPRESA_1)
  })

  it('se o código sentinela existir, nenhum dado do cliente sai na resposta', async () => {
    wmApiClient.consultarClientes.mockResolvedValue(ACHOU)

    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(res.body.erp_alcancavel).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('SENTINELA EXISTE')
    expect(res.body.cliente).toBeUndefined()
    expect(res.body.candidatos).toBeUndefined()
  })

  it('o telefone autorizado nunca aparece na resposta', async () => {
    const res = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
    expect(JSON.stringify(res.body)).not.toContain(TELEFONE_EMPRESA_1)
  })
})

/* ================================================================== *
 * 4. Cache dos DOIS vereditos
 * ================================================================== */

describe('cache de 30 s', () => {
  beforeEach(ligarModulo)

  it('o veredito NEGATIVO é cacheado — é o caro de reapurar (2,5 s de timeout)', async () => {
    wmApiClient.consultarClientes.mockResolvedValue(OFFLINE)

    const a = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
    const b = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(a.body.erp_alcancavel).toBe(false)
    expect(b.body.erp_alcancavel).toBe(false)
    expect(b.body.origem_resposta).toBe('cache')
    expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(1)
  })

  it('o veredito POSITIVO também é cacheado', async () => {
    const a = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
    const b = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)

    expect(a.body.erp_alcancavel).toBe(true)
    expect(b.body.origem_resposta).toBe('cache')
    expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(1)
  })

  it('chamadas simultâneas coalescem numa sonda só', async () => {
    let resolver
    wmApiClient.consultarClientes.mockReturnValue(new Promise((r) => { resolver = r }))

    const chamadas = [
      request(app).get(ROTA).set('Authorization', `Bearer ${token()}`),
      request(app).get(ROTA).set('Authorization', `Bearer ${token()}`),
      request(app).get(ROTA).set('Authorization', `Bearer ${token()}`),
    ]
    // Dá tempo das três entrarem no serviço antes de a sonda responder.
    await new Promise((r) => setImmediate(r))
    resolver(OFFLINE)
    const res = await Promise.all(chamadas)

    for (const r of res) expect(r.body.erp_alcancavel).toBe(false)
    expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(1)
  })

  it('o cache expira e a loja que voltou é percebida', async () => {
    wmApiClient.consultarClientes.mockResolvedValue(OFFLINE)
    const antes = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
    expect(antes.body.erp_alcancavel).toBe(false)

    // Avança além do TTL sem esperar de verdade.
    const real = Date.now
    Date.now = () => real() + servico.DISPONIBILIDADE_TTL_MS + 1
    try {
      wmApiClient.consultarClientes.mockResolvedValue(NAO_ACHOU)
      const depois = await request(app).get(ROTA).set('Authorization', `Bearer ${token()}`)
      expect(depois.body.erp_alcancavel).toBe(true)
      expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(2)
    } finally {
      Date.now = real
    }
  })
})

/* ================================================================== *
 * 5. Isolamento
 * ================================================================== */

describe('empresa A não lê o veredito da empresa B', () => {
  beforeEach(ligarModulo)

  it('vereditos diferentes por empresa, e o cache de uma não serve a outra', async () => {
    wmApiClient.consultarClientes.mockImplementation(async (p) =>
      (p.telefone === TELEFONE_EMPRESA_1 ? OFFLINE : NAO_ACHOU)
    )

    const e1 = await request(app).get(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`)
    const e2 = await request(app).get(ROTA).set('Authorization', `Bearer ${token({ id: 77, company_id: 2 })}`)

    expect(e1.body.erp_alcancavel).toBe(false)
    expect(e2.body.erp_alcancavel).toBe(true)
    expect(wmApiClient.consultarClientes).toHaveBeenCalledTimes(2)
  })
})

/* ================================================================== *
 * 6. Leitura pura
 * ================================================================== */

describe('lerDisponibilidade', () => {
  it('mapeia cada caso para o vocabulário fechado', () => {
    const m = (r) => servico.lerDisponibilidade(r)
    expect(m({ ok: true }).erp_alcancavel).toBe(true)
    expect(m({ ok: false, status: 404 }).erp_alcancavel).toBe(true)
    expect(m({ ok: false, status: 503 }).motivo).toBe('sincronizador_offline')
    expect(m({ ok: false, status: 504 }).motivo).toBe('lento')
    expect(m({ ok: false, status: 401 }).motivo).toBe('nao_configurado')
    expect(m({ ok: false, status: 403 }).motivo).toBe('nao_configurado')
    expect(m({ configuracaoInvalida: 'base_url_ausente' }).motivo).toBe('nao_configurado')
    expect(m({ ok: false, transporte: 'timeout' }).motivo).toBe('indisponivel')
    expect(m({ ok: false, status: 500 }).motivo).toBe('indisponivel')
    expect(m(null).motivo).toBe('indisponivel')
  })

  it('nenhum caso devolve motivo em veredito positivo', () => {
    expect(servico.lerDisponibilidade({ ok: true }).motivo).toBeNull()
    expect(servico.lerDisponibilidade({ ok: false, status: 404 }).motivo).toBeNull()
  })
})
