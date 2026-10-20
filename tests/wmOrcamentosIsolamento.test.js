/**
 * Isolamento do orçamento WM — Sessão 3A do doc 36. É o coração desta sessão.
 *
 * POR QUE ESTE ARQUIVO EXISTE: `docs/wm/09-seguranca.md` declara que o Bearer do ZapERP
 * **não restringe a credencial a uma única empresa** e que a WM "confia nesses consumidores
 * para informar o telefone". O telefone autorizado é o ÚNICO seletor de tenant e a WM não tem
 * nenhuma defesa se o errado for enviado (pendência 13 da seção 10). Logo o isolamento entre
 * empresas desta integração é 100% do ZapERP, e é aqui que ele é provado.
 *
 * Também prova o que a Sessão 3A promete sobre superfície: a rota está MONTADA em `app.js` e
 * está FECHADA com `WM_ORCAMENTOS_ENABLED` desligada — 403 em tudo, inclusive para admin.
 *
 * Nenhum teste faz rede real: `wmApiClient` é mock e `global.fetch` falha se chamado.
 */
const request = require('supertest')
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

jest.mock('../services/wm/wmApiClient', () => ({
  consultarProdutos: jest.fn(),
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
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const orcamentoWmFlag = require('../helpers/orcamentoWmFlag')
const cache = require('../services/wm/wmConsultaCache')
const controller = require('../controllers/wmOrcamentosController')
const { CAMPOS_PROIBIDOS } = require('../validators/wmOrcamentosValidators')

const RAIZ = path.join(__dirname, '..')
const ROTA = '/orcamentos/produtos/consultar'
const ROTA_API = '/api/orcamentos/produtos/consultar'

// Contatos autorizados fictícios — o seletor de tenant do lado da WM.
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

function respostaProdutos(marcador) {
  return {
    ok: true,
    status: 200,
    operacao: 'leitura',
    data: {
      dados: {
        status: 'multiplos_produtos',
        produtos: [{ codigo_produto_erp: marcador, descricao: `PRODUTO ${marcador}`, marca: null, unidade: 'UN' }],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 1, tem_mais: false, tem_anterior: false },
      },
      meta: { fonte: 'cache_cloud' },
    },
  }
}

/** Liga o módulo para os testes que precisam passar do gate. */
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
  wmApiClient.consultarProdutos.mockResolvedValue(respostaProdutos('X'))
})

afterEach(() => {
  expect(fetchEspiao).not.toHaveBeenCalled()
})

// =============================================================================
// 1. Rota montada e fechada — a promessa de "não abre superfície"
// =============================================================================
describe('rota montada e fechada com a flag desligada', () => {
  it.each([ROTA, ROTA_API])('%s responde 403 de módulo, não 404', async (rota) => {
    const res = await request(app)
      .post(rota)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa' })

    // 403 (e não 404) é a prova de que a rota ESTÁ montada; o 403 é do gate de módulo.
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })

  it('admin com todas as permissões também recebe 403 com a flag desligada', async () => {
    const res = await request(app)
      .post(ROTA_API)
      .set('Authorization', `Bearer ${token({ perfil: 'admin' })}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
  })

  it('o gate de módulo vem ANTES do de permissão', async () => {
    usuarioTemPermissao.mockResolvedValue(false)
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(403)
    // Módulo desligado não revela nada sobre a permissão do usuário.
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    expect(usuarioTemPermissao).not.toHaveBeenCalled()
  })

  it('é fail-closed: falha ao ler a flag também dá 403', async () => {
    jest.spyOn(orcamentoWmFlag, 'orcamentoWmHabilitado').mockRejectedValue(new Error('banco fora'))
    const silencio = jest.spyOn(console, 'error').mockImplementation(() => {})

    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORCAMENTO_WM_OFF')
    silencio.mockRestore()
  })

  it('sem token é 401 e com token sem company_id é 401 — nem chega ao gate', async () => {
    const semToken = await request(app).post(ROTA).send({ busca: 'chapa' })
    expect(semToken.status).toBe(401)

    const semTenant = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${jwt.sign({ id: 20, perfil: 'admin' }, process.env.JWT_SECRET)}`)
      .send({ busca: 'chapa' })
    expect(semTenant.status).toBe(401)
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 2. Identidade: company_id do JWT, telefone do servidor
// =============================================================================
describe('company_id vem do JWT e o telefone vem do servidor', () => {
  beforeEach(() => { ligarModulo() })

  it('o telefone enviado à WM é o resolvido para o company_id do token', async () => {
    const res = await request(app)
      .post(ROTA_API)
      .set('Authorization', `Bearer ${token({ company_id: 2 })}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(200)
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_2)
    expect(configService.obterConfigInterna).toHaveBeenCalledWith(2)
  })

  it.each(CAMPOS_PROIBIDOS)('body com "%s" é RECUSADO, não sanitizado', async (campo) => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa', [campo]: 'qualquer-valor' })

    expect(res.status).toBe(400)
    expect(res.body.codigo).toBe('ORCAMENTO_DADOS_INVALIDOS')
    expect(res.body.mensagem).toMatch(/não aceito/i)
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })

  it('body com company_id de outra empresa não muda o tenant — é recusado', async () => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 1 })}`)
      .send({ busca: 'chapa', company_id: 2 })

    expect(res.status).toBe(400)
    expect(configService.obterConfigInterna).not.toHaveBeenCalled()
  })

  it('header de tenant forjado é ignorado: o telefone continua o da empresa do token', async () => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 1 })}`)
      .set('x-company-id', '2')
      .set('x-tenant-id', '2')
      .send({ busca: 'chapa' })

    expect(res.status).toBe(200)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_1)
  })

  it('query string de tenant também é ignorada', async () => {
    const res = await request(app)
      .post(`${ROTA}?company_id=2&telefone=5500000000000`)
      .set('Authorization', `Bearer ${token({ company_id: 1 })}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(200)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0].telefone).toBe(TELEFONE_EMPRESA_1)
  })

  it('chave desconhecida e busca XOR código são barrados antes da chamada externa', async () => {
    const comum = (body) => request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send(body)

    expect((await comum({ busca: 'chapa', limite: 10 })).status).toBe(400)
    expect((await comum({ busca: 'chapa', tamanho_pagina: 30 })).status).toBe(400)
    expect((await comum({ busca: 'chapa', codigo_produto_erp: '1' })).status).toBe(400)
    expect((await comum({})).status).toBe(400)
    expect((await comum({ busca: 'x'.repeat(101) })).status).toBe(400)
    expect((await comum({ codigo_produto_erp: '12345678' })).status).toBe(400)
    expect((await comum({ busca: 'chapa', pagina: 0 })).status).toBe(400)
    expect((await comum({ busca: 'chapa', pagina: 1.5 })).status).toBe(400)
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 3. Empresa A não obtém nada da empresa B — inclusive via cache
// =============================================================================
describe('empresa A não obtém nada da empresa B', () => {
  beforeEach(() => {
    ligarModulo()
    wmApiClient.consultarProdutos.mockImplementation(async (payload) =>
      respostaProdutos(payload.telefone === TELEFONE_EMPRESA_1 ? 'EMPRESA-1' : 'EMPRESA-2')
    )
  })

  it('a mesma busca em empresas diferentes devolve catálogos diferentes', async () => {
    const r1 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'chapa' })
    const r2 = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ id: 77, company_id: 2 })}`).send({ busca: 'chapa' })
    const r1DeNovo = await request(app).post(ROTA).set('Authorization', `Bearer ${token({ company_id: 1 })}`).send({ busca: 'chapa' })

    expect(r1.body.produtos[0].codigo_produto_erp).toBe('EMPRESA-1')
    expect(r2.body.produtos[0].codigo_produto_erp).toBe('EMPRESA-2')
    expect(JSON.stringify(r1.body)).not.toContain('EMPRESA-2')
    expect(JSON.stringify(r2.body)).not.toContain('EMPRESA-1')

    // A 3ª requisição é a prova do cache: veio do cache da empresa 1, com o conteúdo da 1.
    expect(r1DeNovo.body.produtos[0].codigo_produto_erp).toBe('EMPRESA-1')
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(2)
  })

  it('empresa sem vínculo não vê nada e não chega à WM', async () => {
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ company_id: 3 })}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_INTEGRACAO_NAO_CONFIGURADA')
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })
})

// =============================================================================
// 4. Permissão
// =============================================================================
describe('permissão orcamentos.ver', () => {
  beforeEach(() => { ligarModulo() })

  it('sem a permissão é 403 e nada chega à WM', async () => {
    usuarioTemPermissao.mockResolvedValue(false)

    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PERMISSAO_NEGADA')
    expect(res.body.permissao).toBe('orcamentos.ver')
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
  })

  it('a permissão é consultada com o company_id e o usuário do token', async () => {
    await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token({ id: 55, company_id: 2, perfil: 'supervisor' })}`)
      .send({ busca: 'chapa' })

    expect(usuarioTemPermissao).toHaveBeenCalledWith({
      usuario_id: 55,
      company_id: 2,
      perfil: 'supervisor',
      permissao_codigo: 'orcamentos.ver',
    })
  })

  it('falha ao avaliar a permissão é fail-closed', async () => {
    usuarioTemPermissao.mockRejectedValue(new Error('banco fora'))
    const silencio = jest.spyOn(console, 'error').mockImplementation(() => {})

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'chapa' })

    expect(res.status).toBe(403)
    expect(wmApiClient.consultarProdutos).not.toHaveBeenCalled()
    silencio.mockRestore()
  })
})

// =============================================================================
// 5. Resposta: sem preço, sem estoque, sem clamp de página
// =============================================================================
describe('resposta ao navegador', () => {
  beforeEach(() => { ligarModulo() })

  it('devolve só os 4 campos do contrato, com paginação e origem declarada', async () => {
    const res = await request(app).post(ROTA_API).set('Authorization', `Bearer ${token()}`).send({ busca: 'chapa' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Object.keys(res.body.produtos[0]).sort()).toEqual(['codigo_produto_erp', 'descricao', 'marca', 'unidade'])
    expect(res.body.paginacao).toEqual({ pagina: 1, tamanho_pagina: 30, total: 1, tem_mais: false, tem_anterior: false })
    expect(res.body.candidatos_origem).toBe('cache_cloud')
    expect(res.body.requestId).toBeTruthy()
  })

  it('nem telefone nem token aparecem na resposta', async () => {
    process.env.ZAPERP_API_TOKEN = 'zaperp_tok_NUNCA_SAIR'
    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'chapa' })
    const corpo = JSON.stringify(res.body)

    expect(corpo).not.toContain(TELEFONE_EMPRESA_1)
    expect(corpo).not.toContain('zaperp_tok_NUNCA_SAIR')
    expect(corpo).not.toMatch(/telefone/i)
    delete process.env.ZAPERP_API_TOKEN
  })

  it('página fora do intervalo volta 400 sem corrigir a página', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: false,
      status: 400,
      operacao: 'leitura',
      data: { erro: 'PAGINA_FORA_DO_INTERVALO' },
      erroWm: 'PAGINA_FORA_DO_INTERVALO',
      indiceItem: null,
      transporte: null,
      respostaInvalida: false,
      configuracaoInvalida: null,
    })

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'chapa', pagina: 999 })

    expect(res.status).toBe(400)
    expect(res.body.codigo).toBe('WM_PAGINA_FORA_DO_INTERVALO')
    expect(wmApiClient.consultarProdutos).toHaveBeenCalledTimes(1)
    expect(wmApiClient.consultarProdutos.mock.calls[0][0].pagina).toBe(999)
  })

  it('erro da WM não atravessa cru e o 401 dela não vira 401 local', async () => {
    wmApiClient.consultarProdutos.mockResolvedValue({
      ok: false,
      status: 401,
      operacao: 'leitura',
      data: { erro: 'TOKEN_ASSISTENTE_INVALIDO' },
      erroWm: 'TOKEN_ASSISTENTE_INVALIDO',
      indiceItem: null,
      transporte: null,
      respostaInvalida: false,
      configuracaoInvalida: null,
    })
    const silencio = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await request(app).post(ROTA).set('Authorization', `Bearer ${token()}`).send({ busca: 'chapa' })

    // 401 local deslogaria o atendente pelo interceptor do frontend.
    expect(res.status).toBe(503)
    expect(res.body.codigo).toBe('WM_CREDENCIAL_INVALIDA')
    expect(JSON.stringify(res.body)).not.toContain('TOKEN_ASSISTENTE_INVALIDO')

    const logado = silencio.mock.calls.flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
    expect(logado).not.toContain(TELEFONE_EMPRESA_1)
    silencio.mockRestore()
  })
})

// =============================================================================
// 6. Acesso à conversa (D9) — choke point pronto para a Sessão 4
// =============================================================================
describe('acesso à conversa', () => {
  const contexto = { company_id: 1, conversa_id: 10, user_id: 20, role: 'atendente', user_dep_ids: [3] }

  it('a rota de produtos NÃO aceita conversa_id — por isso o guarda não está nela', async () => {
    ligarModulo()
    const res = await request(app)
      .post(ROTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ busca: 'chapa', conversa_id: 10 })

    expect(res.status).toBe(400)
    expect(res.body.codigo).toBe('ORCAMENTO_DADOS_INVALIDOS')
  })

  it('usuário sem acesso à conversa recebe 403, pela política canônica', async () => {
    assertPermissaoConversa.mockResolvedValue({ ok: false, status: 403, error: 'Conversa de um número que você não pode ver' })

    const r = await controller.garantirAcessoConversa(contexto)

    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.codigo).toBe('ORCAMENTO_CONVERSA_NEGADA')
    // A política é CHAMADA com o company_id e o usuário de quem pediu — não reimplementada.
    expect(assertPermissaoConversa).toHaveBeenCalledWith(contexto)
  })

  it('conversa inexistente é 404 e falha de leitura é 503', async () => {
    assertPermissaoConversa.mockResolvedValue({ ok: false, status: 404, error: 'Conversa não encontrada' })
    expect((await controller.garantirAcessoConversa(contexto)).status).toBe(404)

    assertPermissaoConversa.mockResolvedValue({ ok: false, status: 500, error: 'erro de banco' })
    const r = await controller.garantirAcessoConversa(contexto)
    expect(r.status).toBe(503)
    expect(r.mensagem).not.toMatch(/banco/i)
  })

  it('grupo, comunidade e lista de transmissão não iniciam orçamento', async () => {
    const naoIndividuais = [
      { id: 10, tipo: 'grupo' },
      { id: 10, tipo: 'group' },
      { id: 10, tipo: 'comunidade' },
      { id: 10, tipo: 'community' },
      { id: 10, tipo: 'individual', telefone: '55349999999-123@g.us' },
      { id: 10, tipo: 'individual', isGroup: true },
      { id: 10, tipo: 'individual', telefone: '123@broadcast' },
      { id: 10, tipo: 'individual', telefone: '123@newsletter' },
    ]

    for (const conv of naoIndividuais) {
      assertPermissaoConversa.mockResolvedValue({ ok: true, conv })
      const r = await controller.garantirAcessoConversa(contexto)
      expect(r.ok).toBe(false)
      expect(r.codigo).toBe('ORCAMENTO_CONVERSA_NAO_INDIVIDUAL')
      expect(r.status).toBe(422)
    }
  })

  it('conversa individual com acesso passa', async () => {
    assertPermissaoConversa.mockResolvedValue({ ok: true, conv: { id: 10, tipo: 'individual', telefone: '5534991847800' } })
    const r = await controller.garantirAcessoConversa(contexto)
    expect(r.ok).toBe(true)
    expect(r.conv.id).toBe(10)
  })
})

// =============================================================================
// 7. Varredura estática — isolamento não depende de ninguém lembrar
// =============================================================================
describe('varredura estática dos arquivos da Sessão 3A', () => {
  const ARQUIVOS_3A = [
    'routes/wmOrcamentosRoutes.js',
    'controllers/wmOrcamentosController.js',
    'services/wm/wmAssistenteService.js',
    'services/wm/wmConsultaCache.js',
  ]
  const TABELAS_NOVAS = ['wm_orcamento_integracoes', 'wm_orcamento_operacoes']

  function ler(rel) {
    return fs.readFileSync(path.join(RAIZ, rel), 'utf8')
  }

  it('todos os arquivos existem', () => {
    for (const rel of ARQUIVOS_3A) expect(fs.existsSync(path.join(RAIZ, rel))).toBe(true)
  })

  it('toda query às tabelas novas filtra company_id', () => {
    const faltando = []
    for (const rel of ARQUIVOS_3A) {
      const src = ler(rel)
      for (const tabela of TABELAS_NOVAS) {
        const marcador = `.from('${tabela}')`
        let i = src.indexOf(marcador)
        while (i !== -1) {
          const trecho = src.slice(i, Math.min(src.length, i + 700))
          if (!/\.eq\(\s*['"]company_id['"]/.test(trecho) && !/company_id\s*:/.test(trecho)) {
            faltando.push(`${rel} (offset ${i})`)
          }
          i = src.indexOf(marcador, i + marcador.length)
        }
      }
    }
    expect(faltando).toEqual([])
  })

  it('nenhum arquivo da 3A acessa o Supabase direto — a leitura é delegada ao service da 2A', () => {
    for (const rel of ARQUIVOS_3A) {
      expect(ler(rel)).not.toMatch(/require\(['"].*config\/supabase['"]\)/)
    }
  })

  it('o company_id do controller sai de req.user, e não de body/query/header', () => {
    const src = ler('controllers/wmOrcamentosController.js')
    expect(src).toMatch(/req\.user\?\.company_id/)
    expect(src).not.toMatch(/req\.body(\.|\[['"])company_id/)
    expect(src).not.toMatch(/req\.query(\.|\[['"])company_id/)
    expect(src).not.toMatch(/req\.headers\[?['"]?x-company/i)
  })

  it('a rota monta auth → módulo → permissão, nesta ordem', () => {
    const src = ler('routes/wmOrcamentosRoutes.js')
    const iAuth = src.indexOf('router.use(auth)')
    const iModulo = src.indexOf('router.use(requireOrcamentoWm)')
    // A partir do `router.post` — a cadeia também está descrita no cabeçalho do arquivo.
    const iPost = src.indexOf('router.post(')
    const iPermissao = src.indexOf("requirePermissao('orcamentos.ver')", iPost)
    expect(iAuth).toBeGreaterThan(-1)
    expect(iPost).toBeGreaterThan(-1)
    expect(iModulo).toBeGreaterThan(iAuth)
    expect(iPermissao).toBeGreaterThan(iModulo)
  })

  it('o cache não cacheia preparar nem criar', () => {
    const src = ler('services/wm/wmAssistenteService.js')
    // A 3A não chama nenhum dos dois; a varredura é a trava para quem vier depois.
    expect(src).not.toMatch(/prepararOrcamento|criarOrcamento/)
  })

  it('app.js monta /orcamentos nos dois prefixos, com apiLimiter no direto', () => {
    const src = ler('app.js')
    expect(src).toMatch(/app\.use\('\/orcamentos', apiLimiter, wmOrcamentosRoutes\)/)
    expect(src).toMatch(/api\.use\('\/orcamentos', wmOrcamentosRoutes\)/)
  })
})
