/**
 * Cliente HTTP da API WM (doc 36, D5 e Sessão 2B).
 *
 * Mocks montados a partir dos schemas do `docs/wm/openapi.yaml` — as fixtures sanitizadas da WM
 * são pendência da Sessão 0 e servem às Sessões 3 e 4. NENHUM teste aqui faz rede real:
 * `global.fetch` é substituído por mock em todos eles, e há teste provando que as chamadas
 * bloqueadas por configuração nem chegam ao fetch.
 */
const fs = require('fs')
const path = require('path')

const client = require('../services/wm/wmApiClient')

const BASE_OK = 'https://api-wm.exemplo.com.br'
const TOKEN = 'zaperp_tok_AbCdEf0123456789'
// Telefone de fixture fictício — é o CONTATO AUTORIZADO da WM, nunca pode cair em log.
const TELEFONE_AUTORIZADO = '5511999990000'

const ENV_ORIGINAL = {}
const CHAVES_ENV = [
  'WM_API_BASE_URL',
  'ZAPERP_API_TOKEN',
  'WM_API_TIMEOUT_READ_MS',
  'WM_API_TIMEOUT_WRITE_MS',
  'WM_API_DEBUG',
]

/** Response-like sem `body` stream → o cliente cai no caminho `res.text()`. */
function respostaMock({ status = 200, corpo = null, contentType = 'application/json', contentLength = null }) {
  const texto = corpo == null ? '' : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(nome) {
        const k = String(nome || '').toLowerCase()
        if (k === 'content-type') return contentType
        if (k === 'content-length') return contentLength == null ? null : String(contentLength)
        return null
      },
    },
    text: async () => texto,
  }
}

/** Response-like COM stream, para exercitar o teto de bytes antes de materializar o corpo. */
function respostaStreamMock({ status = 200, pedacos = [], contentType = 'application/json' }) {
  let i = 0
  let cancelado = false
  const reader = {
    async read() {
      if (cancelado || i >= pedacos.length) return { done: true, value: undefined }
      const v = Buffer.from(pedacos[i++])
      return { done: false, value: v }
    },
    async cancel() { cancelado = true },
    get cancelado() { return cancelado },
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? contentType : null) },
    body: { getReader: () => reader },
    text: async () => pedacos.join(''),
    _reader: reader,
  }
}

function erroDeConexao(code = 'ENOTFOUND') {
  const e = new Error('falha de conexão')
  e.code = code
  return e
}

function erroDeTimeout() {
  const e = new Error('abortado')
  e.name = 'TimeoutError'
  return e
}

beforeEach(() => {
  for (const k of CHAVES_ENV) ENV_ORIGINAL[k] = process.env[k]
  process.env.WM_API_BASE_URL = BASE_OK
  process.env.ZAPERP_API_TOKEN = TOKEN
  delete process.env.WM_API_TIMEOUT_READ_MS
  delete process.env.WM_API_TIMEOUT_WRITE_MS
  delete process.env.WM_API_DEBUG
  global.fetch = jest.fn()
  // O retryWithBackoff loga aviso a cada retentativa; silenciado para não poluir a saída.
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of CHAVES_ENV) {
    if (ENV_ORIGINAL[k] === undefined) delete process.env[k]
    else process.env[k] = ENV_ORIGINAL[k]
  }
  jest.restoreAllMocks()
  delete global.fetch
})

describe('wmApiClient — URL, headers e segredos', () => {
  it('monta a URL só a partir de WM_API_BASE_URL + caminho do OpenAPI', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'notebook' })

    const [url] = global.fetch.mock.calls[0]
    expect(url).toBe(`${BASE_OK}/api/v1/assistente/produtos/consultar`)
  })

  it('usa os três caminhos exatos do openapi.yaml', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })
    await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(global.fetch.mock.calls.map((c) => c[0])).toEqual([
      `${BASE_OK}/api/v1/assistente/produtos/consultar`,
      `${BASE_OK}/api/v1/assistente/orcamentos/preparar`,
      `${BASE_OK}/api/v1/assistente/orcamentos/criar`,
    ])
  })

  it('manda Authorization Bearer em header, Content-Type json e redirect: error', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    const [url, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers.accept).toBe('application/json')
    expect(opts.method).toBe('POST')
    expect(opts.redirect).toBe('error')
    // Token NUNCA na URL/query (o /media/proxy já ensinou o preço disso).
    expect(url).not.toContain(TOKEN)
    expect(url).not.toContain('token')
  })

  it('cada tentativa recebe um AbortSignal novo (signal é getter, não valor fixo)', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    const [, opts] = global.fetch.mock.calls[0]
    const a = opts.signal
    const b = opts.signal
    expect(a).toBeDefined()
    expect(a).not.toBe(b)
  })

  it('não existe desligamento de TLS em nenhum lugar do CÓDIGO do módulo', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'services', 'wm', 'wmApiClient.js'), 'utf8')
    // Comentários citam `rejectUnauthorized: false` de propósito, para avisar que os vizinhos
    // produtosDb.js / wmSqlServer.js fazem o oposto. O que não pode existir é no código.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(codigo).not.toMatch(/rejectUnauthorized/)
    expect(codigo).not.toMatch(/trustServerCertificate/)
    expect(codigo).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
    expect(codigo).not.toMatch(/\bagent\b|\bdispatcher\b/)
  })

  it('as opções de fetch não carregam agent/dispatcher/TLS customizado', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    const [, opts] = global.fetch.mock.calls[0]
    expect(Object.keys(opts).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal'])
  })

  it('mascara o token em log e NUNCA imprime token, telefone nem corpo', async () => {
    const logs = []
    jest.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
    global.fetch.mockResolvedValue(respostaMock({ status: 503, corpo: { erro: 'SINCRONIZADOR_OFFLINE' } }))

    await client.prepararOrcamento({
      telefone: TELEFONE_AUTORIZADO,
      cliente_busca: 'João da Silva',
      itens: [{ busca: 'notebook', quantidade: '1' }],
    })

    const saida = logs.join('\n')
    expect(saida).toContain('[WM RESPONSE]')
    expect(saida).toContain(client.maskToken(TOKEN))
    expect(saida).not.toContain(TOKEN)
    expect(saida).not.toContain(TELEFONE_AUTORIZADO)
    // Nem o telefone inteiro nem pedaço dele: 4 últimos, 4 primeiros, sem DDI.
    expect(saida).not.toContain(TELEFONE_AUTORIZADO.slice(-4))
    expect(saida).not.toContain(TELEFONE_AUTORIZADO.slice(0, 4))
    expect(saida).not.toContain('João da Silva')
    expect(saida).toContain('SINCRONIZADOR_OFFLINE')
  })

  it('em sucesso não loga nada sem WM_API_DEBUG', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))
    await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })
    expect(log).not.toHaveBeenCalled()
  })

  it('maskToken não devolve o segredo em nenhum tamanho', () => {
    expect(client.maskToken(TOKEN)).not.toContain(TOKEN.slice(2, -2))
    expect(client.maskToken('ab')).toBe('****')
    expect(client.maskToken('')).toBe('***')
    expect(client.maskToken(null)).toBe('***')
  })
})

describe('wmApiClient — base URL validada (anti-SSRF, TLS, sem descoberta)', () => {
  const casos = [
    ['', 'base_url_ausente'],
    ['   ', 'base_url_ausente'],
    ['nao-e-url', 'base_url_invalida'],
    ['http://api-wm.exemplo.com.br', 'base_url_sem_tls'],
    ['https://usuario:senha@api-wm.exemplo.com.br', 'base_url_com_credencial'],
    ['https://api-wm.exemplo.com.br/?x=1', 'base_url_com_query'],
    ['https://api-wm.exemplo.com.br/#frag', 'base_url_com_query'],
    ['https://localhost', 'base_url_host_nao_publico'],
    ['https://127.0.0.1', 'base_url_host_nao_publico'],
    ['https://10.0.0.5', 'base_url_host_nao_publico'],
    ['https://192.168.1.10', 'base_url_host_nao_publico'],
    ['https://172.16.3.9', 'base_url_host_nao_publico'],
    ['https://169.254.169.254', 'base_url_host_nao_publico'],
    ['https://100.100.1.1', 'base_url_host_nao_publico'],
    ['https://[::1]', 'base_url_host_nao_publico'],
    ['https://servidor.internal', 'base_url_host_nao_publico'],
    ['https://api-wm.exemplo.com.br/api/v1', 'base_url_com_prefixo_api'],
    ['https://api-wm.exemplo.com.br/api', 'base_url_com_prefixo_api'],
  ]

  it.each(casos)('recusa base %s com motivo %s e NÃO chama fetch', async (base, motivo) => {
    process.env.WM_API_BASE_URL = base
    const r = await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    expect(r.configuracaoInvalida).toBe(motivo)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
    expect(r.transporte).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('aceita host público e prefixo de caminho que não seja /api', () => {
    process.env.WM_API_BASE_URL = 'https://api-wm.exemplo.com.br/wm/'
    expect(client.resolveBaseUrl()).toEqual({ ok: true, base: 'https://api-wm.exemplo.com.br/wm' })
  })

  describe('base de produção da WM já traz /api/v1/assistente', () => {
    // O guia da 2ª remessa (§2) publica a base como
    // https://apiwmassistente.wmsistemas.inf.br/api/v1/assistente — e TODOS os caminhos do
    // openapi.yaml também começam com /api/v1/assistente. Sem cortar o sufixo, a URL final
    // seria /api/v1/assistente/api/v1/assistente/produtos/consultar: 404 silencioso.
    const BASE_PUBLICADA = 'https://apiwmassistente.wmsistemas.inf.br/api/v1/assistente'

    it('o sufixo é cortado da base, não somado ao caminho', () => {
      process.env.WM_API_BASE_URL = BASE_PUBLICADA
      expect(client.resolveBaseUrl()).toEqual({ ok: true, base: 'https://apiwmassistente.wmsistemas.inf.br' })
    })

    it('com barra no fim dá o mesmo resultado', () => {
      process.env.WM_API_BASE_URL = `${BASE_PUBLICADA}/`
      expect(client.resolveBaseUrl()).toEqual({ ok: true, base: 'https://apiwmassistente.wmsistemas.inf.br' })
    })

    it.each([
      ['produtos/consultar', () => client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })],
      ['clientes/consultar', () => client.consultarClientes({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })],
      ['orcamentos/preparar', () => client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })],
      ['orcamentos/criar', () => client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })],
    ])('%s sai com o prefixo UMA vez', async (caminho, chamar) => {
      process.env.WM_API_BASE_URL = BASE_PUBLICADA
      global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} } }))

      await chamar()

      const [url] = global.fetch.mock.calls[0]
      expect(url).toBe(`https://apiwmassistente.wmsistemas.inf.br/api/v1/assistente/${caminho}`)
      expect(url).not.toContain('/api/v1/assistente/api/v1/assistente')
      // Contagem explícita: uma ocorrência do prefixo, nunca duas.
      expect(url.split(client.PREFIXO_OPENAPI).length - 1).toBe(1)
    })

    it('uma base atrás de path + o prefixo oficial preserva o path', () => {
      process.env.WM_API_BASE_URL = `https://proxy.exemplo.com.br/wm${client.PREFIXO_OPENAPI}`
      expect(client.resolveBaseUrl()).toEqual({ ok: true, base: 'https://proxy.exemplo.com.br/wm' })
    })

    it('base que termina em /api ou /api/v1 continua RECUSADA (não há o que cortar)', () => {
      for (const base of ['https://api-wm.exemplo.com.br/api', 'https://api-wm.exemplo.com.br/api/v1']) {
        process.env.WM_API_BASE_URL = base
        expect(client.resolveBaseUrl()).toEqual({ ok: false, motivo: 'base_url_com_prefixo_api' })
      }
    })
  })

  it('aceita IP literal público e recusa os privados', () => {
    expect(client.hostPermitido('200.100.50.25')).toBe(true)
    expect(client.hostPermitido('10.1.2.3')).toBe(false)
    expect(client.hostPermitido('fd00::1')).toBe(false)
    expect(client.hostPermitido('fe80::1')).toBe(false)
    expect(client.hostPermitido('239.1.1.1')).toBe(false)
  })

  it('sem token não chama fetch e marca configuração inválida', async () => {
    delete process.env.ZAPERP_API_TOKEN
    const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r.configuracaoInvalida).toBe('token_ausente')
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('wmApiClient — timeout por tipo de operação', () => {
  it('usa os padrões documentados quando o env não define (SLA da WM é pendência 6)', () => {
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(client.TIMEOUT_READ_PADRAO_MS)
    expect(client.resolveTimeoutMs(client.OPERACAO.PREPARACAO)).toBe(client.TIMEOUT_WRITE_PADRAO_MS)
    expect(client.resolveTimeoutMs(client.OPERACAO.CRIACAO)).toBe(client.TIMEOUT_WRITE_PADRAO_MS)
  })

  it('respeita WM_API_TIMEOUT_READ_MS e WM_API_TIMEOUT_WRITE_MS', () => {
    process.env.WM_API_TIMEOUT_READ_MS = '7000'
    process.env.WM_API_TIMEOUT_WRITE_MS = '41000'
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(7000)
    expect(client.resolveTimeoutMs(client.OPERACAO.CRIACAO)).toBe(41000)
  })

  it('ignora valor inválido e limita o absurdo', () => {
    process.env.WM_API_TIMEOUT_READ_MS = 'abc'
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(client.TIMEOUT_READ_PADRAO_MS)
    process.env.WM_API_TIMEOUT_READ_MS = '0'
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(client.TIMEOUT_READ_PADRAO_MS)
    process.env.WM_API_TIMEOUT_READ_MS = '99999999'
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(120000)
    process.env.WM_API_TIMEOUT_READ_MS = '5'
    expect(client.resolveTimeoutMs(client.OPERACAO.LEITURA)).toBe(1000)
  })
})

describe('wmApiClient — política de retry (o núcleo de segurança, D5)', () => {
  it('criar NÃO repete em 5xx: uma tentativa e devolve o status', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 500, corpo: { erro: 'boom' } }))
    const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(500)
    expect(r.ok).toBe(false)
  })

  it('criar NÃO repete em timeout — repetir duplicaria orçamento no ERP', async () => {
    global.fetch.mockRejectedValue(erroDeTimeout())
    const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(r.transporte).toBe('timeout')
    expect(r.status).toBe(0)
  })

  it('criar NÃO repete nem em erro de conexão (reconciliação é explícita, D10)', async () => {
    global.fetch.mockRejectedValue(erroDeConexao('ECONNREFUSED'))
    const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(r.transporte).toBe('conexao')
  })

  it('criar NÃO repete em 429 nem em 408', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 429, corpo: {} }))
    await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(global.fetch).toHaveBeenCalledTimes(1)

    global.fetch.mockClear()
    global.fetch.mockResolvedValue(respostaMock({ status: 408, corpo: {} }))
    await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('produtos/consultar repete 5xx (leitura é idempotente) e termina com sucesso', async () => {
    global.fetch
      .mockResolvedValueOnce(respostaMock({ status: 500, corpo: {} }))
      .mockResolvedValueOnce(respostaMock({ status: 200, corpo: { dados: { status: 'multiplos_produtos' }, meta: {} } }))

    const r = await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'notebook' })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('produtos/consultar repete timeout (nada é escrito numa leitura)', async () => {
    global.fetch
      .mockRejectedValueOnce(erroDeTimeout())
      .mockResolvedValueOnce(respostaMock({ status: 200, corpo: { dados: {}, meta: {} } }))

    const r = await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('preparar repete SÓ erro de conexão', async () => {
    global.fetch
      .mockRejectedValueOnce(erroDeConexao('EAI_AGAIN'))
      .mockResolvedValueOnce(respostaMock({ status: 200, corpo: { dados: { status: 'pronto_para_confirmacao' }, meta: {} } }))

    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('preparar NÃO repete timeout nem 5xx (resposta recebida = pode ter sido processada)', async () => {
    global.fetch.mockRejectedValue(erroDeTimeout())
    const t = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(t.transporte).toBe('timeout')

    global.fetch.mockClear()
    global.fetch.mockResolvedValue(respostaMock({ status: 503, corpo: { erro: 'SINCRONIZADOR_OFFLINE' } }))
    const s = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(s.status).toBe(503)
  })

  it('consultarClientes repete 5xx como leitura idempotente (nada é escrito)', async () => {
    global.fetch
      .mockResolvedValueOnce(respostaMock({ status: 503, corpo: { erro: 'SINCRONIZADOR_OFFLINE' } }))
      .mockResolvedValueOnce(respostaMock({ corpo: { dados: {}, meta: {} } }))

    const r = await client.consultarClientes({ telefone: TELEFONE_AUTORIZADO, busca: 'maria' })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
  })

  it('consultarClientes devolve o 503 SINCRONIZADOR_OFFLINE que a rota não declara no OpenAPI', async () => {
    // Medido em produção em 25/10/2026: esta porta é realtime e cai com o sincronizador da loja,
    // enquanto `produtos/consultar` (acervo sincronizado dentro da WM) segue respondendo 200.
    global.fetch.mockResolvedValue(respostaMock({ status: 503, corpo: { erro: 'SINCRONIZADOR_OFFLINE' } }))

    const r = await client.consultarClientes({ telefone: TELEFONE_AUTORIZADO, busca: 'maria' })

    expect(r.ok).toBe(false)
    expect(r.status).toBe(503)
    expect(r.erroWm).toBe('SINCRONIZADOR_OFFLINE')
    expect(r.transporte).toBeNull()
  })
})

describe('wmApiClient — leitura da resposta', () => {
  it('lê o código de erro da chave `erro` (não `codigo`, não `error`)', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 503, corpo: { erro: 'SINCRONIZADOR_OFFLINE' } }))
    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r.erroWm).toBe('SINCRONIZADOR_OFFLINE')

    global.fetch.mockResolvedValue(respostaMock({ status: 503, corpo: { codigo: 'X', error: 'Y' } }))
    const outro = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(outro.erroWm).toBeNull()
  })

  it('preserva indice_item zero-based do 502 de preparar', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 502, corpo: { erro: 'PRODUTO_INATIVO', indice_item: 0 } }))
    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r.indiceItem).toBe(0)
    expect(r.erroWm).toBe('PRODUTO_INATIVO')

    global.fetch.mockResolvedValue(respostaMock({ status: 502, corpo: { erro: 'PRODUTO_NAO_ENCONTRADO', indice_item: 3 } }))
    const r2 = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r2.indiceItem).toBe(3)
  })

  it('ignora indice_item fora do contrato', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 502, corpo: { erro: 'X', indice_item: -1 } }))
    expect((await client.prepararOrcamento({})).indiceItem).toBeNull()

    global.fetch.mockResolvedValue(respostaMock({ status: 502, corpo: { erro: 'X', indice_item: '2' } }))
    expect((await client.prepararOrcamento({})).indiceItem).toBeNull()
  })

  it('sanitiza o código da WM (entrada hostil: shared/http/errors.ts não foi recebido)', () => {
    expect(client.sanitizarCodigoErro('SINCRONIZADOR_OFFLINE')).toBe('SINCRONIZADOR_OFFLINE')
    expect(client.sanitizarCodigoErro('payload_invalido')).toBe('payload_invalido')
    expect(client.sanitizarCodigoErro('<script>alert(1)</script>')).toBe('scriptalert1script')
    expect(client.sanitizarCodigoErro('X'.repeat(500)).length).toBe(64)
    expect(client.sanitizarCodigoErro(42)).toBeNull()
    expect(client.sanitizarCodigoErro('   ')).toBeNull()
  })

  it('recusa 2xx com content-type que não é JSON', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 200, corpo: '<html>login</html>', contentType: 'text/html' }))
    const r = await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'x' })

    expect(r.ok).toBe(false)
    expect(r.respostaInvalida).toBe(true)
    expect(r.data).toBeNull()
  })

  it('aceita content-type JSON com charset e variantes +json', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: {}, meta: {} }, contentType: 'application/json; charset=utf-8' }))
    expect((await client.consultarProdutos({ busca: 'x' })).ok).toBe(true)

    global.fetch.mockResolvedValue(respostaMock({ corpo: { erro: 'x' }, status: 400, contentType: 'application/problem+json' }))
    expect((await client.consultarProdutos({ busca: 'x' })).erroWm).toBe('x')
  })

  it('recusa 2xx com JSON inválido', async () => {
    global.fetch.mockResolvedValue(respostaMock({ status: 200, corpo: '{nao e json' }))
    const r = await client.consultarProdutos({ busca: 'x' })
    expect(r.respostaInvalida).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('recusa resposta acima do teto por content-length, sem ler o corpo', async () => {
    const res = respostaMock({ status: 200, corpo: { dados: {} }, contentLength: client.MAX_RESPONSE_BYTES + 1 })
    const spyText = jest.spyOn(res, 'text')
    global.fetch.mockResolvedValue(res)

    const r = await client.consultarProdutos({ busca: 'x' })
    expect(r.respostaInvalida).toBe(true)
    expect(spyText).not.toHaveBeenCalled()
  })

  it('corta o stream ao passar do teto de bytes e cancela o reader', async () => {
    const pedaco = 'a'.repeat(300 * 1024)
    const res = respostaStreamMock({ status: 200, pedacos: [pedaco, pedaco, pedaco, pedaco, pedaco] })
    global.fetch.mockResolvedValue(res)

    const r = await client.consultarProdutos({ busca: 'x' })
    expect(r.respostaInvalida).toBe(true)
    expect(res._reader.cancelado).toBe(true)
  })

  it('lê corpo via stream quando ele existe e está dentro do teto', async () => {
    const corpo = JSON.stringify({ dados: { status: 'multiplos_produtos' }, meta: { fonte: 'cache_cloud' } })
    global.fetch.mockResolvedValue(respostaStreamMock({ status: 200, pedacos: [corpo.slice(0, 10), corpo.slice(10)] }))

    const r = await client.consultarProdutos({ busca: 'x' })
    expect(r.ok).toBe(true)
    expect(r.data.dados.status).toBe('multiplos_produtos')
  })

  it('redirect bloqueado (redirect: error faz o fetch lançar) não é seguido', async () => {
    const e = new TypeError('unexpected redirect')
    global.fetch.mockRejectedValue(e)
    const r = await client.consultarProdutos({ busca: 'x' })

    expect(r.transporte).toBe('desconhecido')
    expect(r.status).toBe(0)
  })
})

describe('wmApiClient — formas de resposta do contrato (mocks do openapi.yaml)', () => {
  it('multiplos_produtos: produtos sem preço e sem estoque, com paginacao de 30', async () => {
    const corpo = {
      dados: {
        status: 'multiplos_produtos',
        produtos: [
          { codigo_produto_erp: '1234567', descricao: 'NOTEBOOK LENOVO IDEAPAD', marca: 'LENOVO', unidade: 'UN' },
          { codigo_produto_erp: '7654321', descricao: 'NOTEBOOK DELL INSPIRON', marca: 'DELL', unidade: 'UN' },
        ],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 94, tem_mais: true, tem_anterior: false },
      },
      meta: { fonte: 'cache_cloud' },
    }
    global.fetch.mockResolvedValue(respostaMock({ corpo }))

    const r = await client.consultarProdutos({ telefone: TELEFONE_AUTORIZADO, busca: 'notebook' })

    expect(r.ok).toBe(true)
    expect(r.data.dados.paginacao.tamanho_pagina).toBe(30)
    expect(r.data.dados.produtos[0]).not.toHaveProperty('preco_unitario')
    expect(r.data.dados.produtos[0]).not.toHaveProperty('estoque_previsto')
  })

  it('produto_ambiguo: candidatos com preco_unitario e estoque_previsto como STRING', async () => {
    const corpo = {
      dados: {
        status: 'produto_ambiguo',
        indice_item: 1,
        candidatos: [
          { codigo_produto_erp: '1234567', descricao: 'MOUSE', unidade: 'UN', preco_unitario: '33.038', estoque_previsto: '-2.125' },
        ],
        paginacao: { pagina: 1, tamanho_pagina: 30, total: 2, tem_mais: false, tem_anterior: false },
      },
      meta: {},
    }
    global.fetch.mockResolvedValue(respostaMock({ corpo }))

    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(r.data.dados.indice_item).toBe(1)
    const c = r.data.dados.candidatos[0]
    expect(typeof c.preco_unitario).toBe('string')
    expect(c.preco_unitario).toBe('33.038')
    expect(typeof c.estoque_previsto).toBe('string')
    expect(c.estoque_previsto).toBe('-2.125')
  })

  it('multiplos_clientes e multiplos_vendedores chegam com os candidatos do contrato', async () => {
    global.fetch.mockResolvedValue(respostaMock({
      corpo: {
        dados: {
          status: 'multiplos_clientes',
          candidatos: [{ codigo_cliente_erp: '000123', nome: 'JOAO DA SILVA', cpf: null, cnpj: null, inscricao_estadual: 'ISENTO' }],
          paginacao: { pagina: 2, tamanho_pagina: 30, total: 31, tem_mais: false, tem_anterior: true },
        },
        meta: {},
      },
    }))
    const cli = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(cli.data.dados.candidatos[0].codigo_cliente_erp).toBe('000123')
    expect(cli.data.dados.paginacao.tem_anterior).toBe(true)

    global.fetch.mockResolvedValue(respostaMock({
      corpo: {
        dados: {
          status: 'multiplos_vendedores',
          candidatos: [{ codigo_vendedor_erp: '77', nome: 'CARLOS SOUZA' }],
          paginacao: { pagina: 1, tamanho_pagina: 30, total: 3, tem_mais: false, tem_anterior: false },
        },
        meta: {},
      },
    }))
    const vend = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(vend.data.dados.candidatos[0].codigo_vendedor_erp).toBe('77')
  })

  it('pronto_para_confirmacao: reconhece o status e preserva `dados` OPACO', async () => {
    // PENDÊNCIA 1 DA SEÇÃO 10 — ABERTA: o openapi.yaml NÃO modela a prévia (não há itens
    // canônicos, preço unitário, subtotal nem total). Não inventar essa estrutura: aqui só se
    // afirma que o status é reconhecido e que `dados` atravessa sem perda, para a Sessão 4.
    const dados = { status: 'pronto_para_confirmacao', campo_desconhecido_da_previa: { qualquer: 'coisa' } }
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados, meta: { fonte: 'tempo_real' } } }))

    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })

    expect(r.ok).toBe(true)
    expect(r.data.dados.status).toBe('pronto_para_confirmacao')
    expect(r.data.dados).toEqual(dados)
  })

  it('meta vazio/ausente não quebra a leitura (contrato só diz `type: object`)', async () => {
    global.fetch.mockResolvedValue(respostaMock({ corpo: { dados: { status: 'pronto_para_confirmacao' } } }))
    const r = await client.prepararOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r.ok).toBe(true)
    expect(r.data.meta).toBeUndefined()
  })

  it('200 da criação é devolvido OPACO pelo cliente, sem interpretação', async () => {
    // O openapi.yaml só descreve "Orçamento criado ou resultado idempotente já concluído"; o
    // shape de §10 da 2ª remessa é lido adiante, por `normalizarResultadoCriacao`, não aqui.
    global.fetch.mockResolvedValue(respostaMock({ corpo: { qualquer: 'coisa' } }))
    const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ qualquer: 'coisa' })
  })

  it('409 da criação chega com o código, sem repetir a chamada', async () => {
    for (const codigo of ['COMANDO_ID_REUTILIZADO', 'COMANDO_NAO_REEXECUTADO', 'RESULTADO_INCERTO']) {
      global.fetch.mockClear()
      global.fetch.mockResolvedValue(respostaMock({ status: 409, corpo: { erro: codigo } }))
      const r = await client.criarOrcamento({ telefone: TELEFONE_AUTORIZADO })
      expect(r.status).toBe(409)
      expect(r.erroWm).toBe(codigo)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    }
  })
})
