/**
 * Diagnóstico de prontidão do Orçamento WM (`scripts/wm-diagnostico-empresa.js`).
 *
 * O que estes testes protegem, em ordem de gravidade:
 *   1. o telefone autorizado NUNCA aparece na saída — só os últimos 4 dígitos;
 *   2. o script é SÓ LEITURA: nenhuma dependência de escrita é sequer chamada;
 *   3. `503 SINCRONIZADOR_OFFLINE` na porta realtime é lido como loja offline — e NÃO
 *      confundido com a WM fora do ar, que é outro impedimento e outra ação;
 *   4. `404` na porta realtime é sincronizador VIVO (consultou e não achou), não falha;
 *   5. migration pela metade (uma tabela legível, a outra não) é apontada nominalmente;
 *   6. exit code reflete o veredito: 0 só quando não há impedimento nenhum.
 *
 * Nenhuma chamada de rede e nenhum banco: as dependências entram por parâmetro
 * (`diagnosticar(opts, deps)`), como em `tests/wmProvisionamento.test.js`.
 */

const script = require('../scripts/wm-diagnostico-empresa')

const TELEFONE = '5517981881417'
const ULTIMOS4 = '1417'

function opcoes(extra = []) {
  const { erros, opts } = script.parseArgs(['--company-id=20', ...extra])
  expect(erros).toEqual([])
  return opts
}

const RESP_OK = { ok: true, status: 200, data: {}, erroWm: null, transporte: null, configuracaoInvalida: null }
const RESP_OFFLINE = { ok: false, status: 503, data: { erro: 'SINCRONIZADOR_OFFLINE' }, erroWm: 'SINCRONIZADOR_OFFLINE', transporte: null, configuracaoInvalida: null }

/** Produtos com um resultado utilizável, no formato do contrato. */
const RESP_PRODUTOS = {
  ...RESP_OK,
  data: {
    dados: {
      status: 'multiplos_produtos',
      produtos: [{ codigo_produto_erp: '0004325', descricao: 'CIMENTO CAMPEAO AZUL CP 2 E 32 50KG' }],
      paginacao: { pagina: 1, tamanho_pagina: 30, total: 6, tem_mais: false, tem_anterior: false },
    },
  },
}

/**
 * Dependências falsas. Por padrão: tudo saudável — env ligada, as duas tabelas legíveis,
 * empresa ativa e provisionada, as três portas da WM respondendo.
 */
function criarDeps({
  env = { WM_ORCAMENTOS_ENABLED: 'true', ZAPERP_API_TOKEN: 'token-de-teste' },
  baseUrl = { ok: true, base: 'https://api.exemplo.test' },
  tabelasComErro = [],
  empresa = { id: 20, nome: 'Tijolar (Paula)', ativo: true },
  config = { configurado: true, ativo: true, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado' },
  telefoneGravado = TELEFONE,
  flagEfetiva = true,
  respAcesso = RESP_OK,
  respProdutos = RESP_PRODUTOS,
  respClientes = RESP_OK,
  respPreparar = { ...RESP_OK, data: { dados: { status: 'pronto_para_confirmacao' } } },
} = {}) {
  const chamadas = { ordem: [], preparar: [], clientes: [] }

  const deps = {
    linhasLog: [],
    chamadas,
    env,
    log: (texto) => { deps.linhasLog.push(String(texto)) },
    supabase: {
      from: (tabela) => {
        chamadas.ordem.push(`from:${tabela}`)
        const falha = tabelasComErro.includes(tabela)
        return {
          select() { return this },
          limit: () => Promise.resolve({ error: falha ? { message: 'relation does not exist' } : null }),
          eq() { return this },
          maybeSingle: () => Promise.resolve({ data: empresa, error: null }),
        }
      },
    },
    wmApiClient: {
      resolveBaseUrl: () => baseUrl,
      validarAcesso: () => { chamadas.ordem.push('validarAcesso'); return Promise.resolve(respAcesso) },
      consultarProdutos: () => { chamadas.ordem.push('consultarProdutos'); return Promise.resolve(respProdutos) },
      consultarClientes: (p) => {
        chamadas.ordem.push('consultarClientes')
        chamadas.clientes.push(p)
        return Promise.resolve(respClientes)
      },
      prepararOrcamento: (p) => {
        chamadas.ordem.push('prepararOrcamento')
        chamadas.preparar.push(p)
        return Promise.resolve(respPreparar)
      },
      // Se o script chamar isto, o teste falha de propósito: diagnóstico não cria orçamento.
      criarOrcamento: () => { throw new Error('criarOrcamento NUNCA deve ser chamado pelo diagnóstico') },
    },
    configService: {
      obterConfigPublica: () => Promise.resolve({ ...config }),
      obterTelefoneAutorizado: () => Promise.resolve(telefoneGravado),
      // Escrita: presente só para provar que não é chamada.
      salvarConfig: () => { throw new Error('salvarConfig NUNCA deve ser chamado pelo diagnóstico') },
      registrarValidacao: () => { throw new Error('registrarValidacao NUNCA deve ser chamado pelo diagnóstico') },
    },
    flagHelper: { orcamentoWmHabilitado: () => Promise.resolve(flagEfetiva) },
  }
  return deps
}

const saida = (deps) => deps.linhasLog.join('\n')

const nomes = (v) => v.impedimentos.map((i) => i.nome)

/* ------------------------------------------------------------------ *
 * parseArgs
 * ------------------------------------------------------------------ */

describe('parseArgs — morre antes de qualquer chamada', () => {
  test('exige --company-id', () => {
    expect(script.parseArgs([]).erros.join(' ')).toContain('--company-id')
  })

  test('recusa company_id não inteiro positivo', () => {
    expect(script.parseArgs(['--company-id=0']).erros.length).toBe(1)
    expect(script.parseArgs(['--company-id=abc']).erros.length).toBe(1)
    expect(script.parseArgs(['--company-id=-3']).erros.length).toBe(1)
  })

  test('recusa opção desconhecida e argumento solto', () => {
    expect(script.parseArgs(['--company-id=1', '--sei-la']).erros.join(' ')).toContain('--sei-la')
    expect(script.parseArgs(['--company-id=1', 'solto']).erros.join(' ')).toContain('solto')
  })

  test('cliente-busca e vendedor-busca andam em par (a WM exige os dois)', () => {
    expect(script.parseArgs(['--company-id=1', '--cliente-busca=maria']).erros.join(' '))
      .toContain('--vendedor-busca')
    expect(script.parseArgs(['--company-id=1', '--vendedor-busca=paula']).erros.join(' '))
      .toContain('--cliente-busca')
    expect(script.parseArgs(['--company-id=1', '--cliente-busca=maria', '--vendedor-busca=paula']).erros)
      .toEqual([])
  })

  test('busca de produto tem default, para não exigir conhecer a base', () => {
    expect(script.parseArgs(['--company-id=1']).opts.buscaProduto).toBe('a')
    expect(script.parseArgs(['--company-id=1', '--busca-produto=cimento']).opts.buscaProduto).toBe('cimento')
  })
})

/* ------------------------------------------------------------------ *
 * lerLiveness — o coração da leitura
 * ------------------------------------------------------------------ */

describe('lerLiveness', () => {
  test('404 é sincronizador VIVO: consultou a base e não achou', () => {
    expect(script.lerLiveness({ ok: false, status: 404 }).estado).toBe('online')
  })

  test('503 é a LOJA offline, e não se confunde com a WM inalcançável', () => {
    expect(script.lerLiveness(RESP_OFFLINE).estado).toBe('offline')
    expect(script.lerLiveness({ ok: false, status: 0, transporte: 'ECONNREFUSED' }).estado)
      .toBe('indisponivel')
  })

  test('separa credencial, autorização, timeout e configuração ausente', () => {
    expect(script.lerLiveness({ ok: false, status: 401 }).estado).toBe('credencial')
    expect(script.lerLiveness({ ok: false, status: 403 }).estado).toBe('nao_autorizado')
    expect(script.lerLiveness({ ok: false, status: 504 }).estado).toBe('lento')
    expect(script.lerLiveness({ configuracaoInvalida: 'base_url_ausente' }).estado).toBe('config')
    expect(script.lerLiveness(null).estado).toBe('erro')
  })
})

/* ------------------------------------------------------------------ *
 * segredo e somente-leitura
 * ------------------------------------------------------------------ */

describe('segredos e escrita', () => {
  test('o telefone autorizado não aparece na saída; só os últimos 4', async () => {
    const deps = criarDeps()
    await script.diagnosticar(opcoes(['--cliente-busca=maria', '--vendedor-busca=paula']), deps)
    const texto = saida(deps)
    expect(texto).not.toContain(TELEFONE)
    expect(texto).not.toContain(TELEFONE.slice(0, 9))
    expect(texto).toContain(`****${ULTIMOS4}`)
  })

  test('o token não aparece na saída', async () => {
    const deps = criarDeps({ env: { WM_ORCAMENTOS_ENABLED: 'true', ZAPERP_API_TOKEN: 'segredo-abc-123' } })
    await script.diagnosticar(opcoes(), deps)
    expect(saida(deps)).not.toContain('segredo-abc-123')
  })

  test('nenhuma escrita é chamada, e orçamento nunca é criado', async () => {
    const deps = criarDeps()
    const { veredito } = await script.diagnosticar(
      opcoes(['--cliente-busca=maria', '--vendedor-busca=paula']), deps,
    )
    expect(veredito.pronta).toBe(true)
    expect(deps.chamadas.ordem).not.toContain('criarOrcamento')
    expect(deps.chamadas.ordem).not.toContain('salvarConfig')
    expect(deps.chamadas.ordem).not.toContain('registrarValidacao')
  })
})

/* ------------------------------------------------------------------ *
 * o achado que motivou o script
 * ------------------------------------------------------------------ */

describe('assimetria entre acervo e realtime', () => {
  test('produto OK + cliente 503: aponta a loja offline, não a WM', async () => {
    const deps = criarDeps({ respClientes: RESP_OFFLINE })
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)

    expect(exitCode).toBe(1)
    expect(nomes(veredito)).toEqual(['sincronizador da loja'])
    // A prova do acervo continua passando — é exatamente o que engana o atendente.
    const produtos = veredito.provas.find((p) => p.nome === 'produtos/consultar')
    expect(produtos.estado).toBe('ok')
    expect(saida(deps)).toMatch(/computador do ERP|máquina do sincronizador|loja não está alcançável/i)
  })

  test('404 na porta realtime não é impedimento', async () => {
    const deps = criarDeps({ respClientes: { ok: false, status: 404, erroWm: null, transporte: null } })
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)
    expect(exitCode).toBe(0)
    expect(veredito.impedimentos).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * migration pela metade — o bug real de 23/10
 * ------------------------------------------------------------------ */

describe('migration', () => {
  test('aponta nominalmente a tabela que falta quando só uma existe', async () => {
    const deps = criarDeps({ tabelasComErro: ['wm_orcamento_operacoes'] })
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)

    expect(exitCode).toBe(1)
    expect(nomes(veredito)).toContain('wm_orcamento_operacoes')
    expect(nomes(veredito)).not.toContain('wm_orcamento_integracoes')
  })
})

/* ------------------------------------------------------------------ *
 * vínculo e flags
 * ------------------------------------------------------------------ */

describe('vínculo da empresa', () => {
  test('provisionado mas desligado é impedimento nomeado', async () => {
    const deps = criarDeps({
      config: { configurado: true, ativo: false, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado' },
      flagEfetiva: false,
    })
    const { veredito } = await script.diagnosticar(opcoes(), deps)
    expect(nomes(veredito)).toContain('ativo na empresa')
  })

  test('validacao_status=autorizado é OK; nao_validado é só aviso; negado bloqueia', async () => {
    const achar = (v) => v.provas.find((p) => p.nome === 'validação na WM').estado

    const ok = await script.diagnosticar(opcoes(), criarDeps())
    expect(achar(ok.veredito)).toBe('ok')

    const aviso = await script.diagnosticar(opcoes(), criarDeps({
      config: { configurado: true, ativo: true, telefone_ultimos4: ULTIMOS4, validacao_status: 'nao_validado' },
    }))
    expect(achar(aviso.veredito)).toBe('aviso')
    expect(nomes(aviso.veredito)).not.toContain('validação na WM')

    const negado = await script.diagnosticar(opcoes(), criarDeps({
      config: { configurado: true, ativo: true, telefone_ultimos4: ULTIMOS4, validacao_status: 'negado' },
    }))
    expect(achar(negado.veredito)).toBe('falha')
    expect(nomes(negado.veredito)).toContain('validação na WM')
  })

  test('sem vínculo provisionado, as portas do ERP não são testadas', async () => {
    const deps = criarDeps({
      config: { configurado: false, ativo: false, telefone_ultimos4: null, validacao_status: 'nao_validado' },
      telefoneGravado: null,
    })
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)

    expect(exitCode).toBe(1)
    expect(veredito.portas_testadas).toBe(false)
    expect(deps.chamadas.ordem).not.toContain('validarAcesso')
    expect(deps.chamadas.ordem).not.toContain('consultarClientes')
  })
})

/* ------------------------------------------------------------------ *
 * ambiente
 * ------------------------------------------------------------------ */

describe('ambiente', () => {
  test('token ausente impede e corta as portas antes de qualquer chamada', async () => {
    const deps = criarDeps({ env: { WM_ORCAMENTOS_ENABLED: 'true' } })
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)

    expect(exitCode).toBe(1)
    expect(nomes(veredito)).toContain('ZAPERP_API_TOKEN')
    expect(veredito.portas_testadas).toBe(false)
    expect(deps.chamadas.ordem).not.toContain('validarAcesso')
  })

  test('base inválida é impedimento e não vira chamada', async () => {
    const deps = criarDeps({ baseUrl: { ok: false, motivo: 'base_url_sem_tls' } })
    const { veredito } = await script.diagnosticar(opcoes(), deps)
    expect(nomes(veredito)).toContain('WM_API_BASE_URL')
    expect(deps.chamadas.ordem).not.toContain('consultarProdutos')
  })

  test('a env desligada se explica como sendo deste processo', async () => {
    const deps = criarDeps({ env: { ZAPERP_API_TOKEN: 't' } })
    const { veredito } = await script.diagnosticar(opcoes(), deps)
    expect(nomes(veredito)).toContain('WM_ORCAMENTOS_ENABLED')
    expect(saida(deps)).toMatch(/\.env local|deste processo/i)
  })
})

/* ------------------------------------------------------------------ *
 * prévia ponta a ponta
 * ------------------------------------------------------------------ */

describe('prévia ponta a ponta', () => {
  test('sem --cliente-busca a prévia não é testada, e isso é aviso, não falha', async () => {
    const deps = criarDeps()
    const { exitCode, veredito } = await script.diagnosticar(opcoes(), deps)

    expect(exitCode).toBe(0)
    expect(deps.chamadas.ordem).not.toContain('prepararOrcamento')
    expect(veredito.provas.find((p) => p.nome === 'preparar').estado).toBe('aviso')
  })

  test('usa o primeiro produto da prova 5 quando --produto é omitido', async () => {
    const deps = criarDeps()
    await script.diagnosticar(opcoes(['--cliente-busca=maria', '--vendedor-busca=paula']), deps)

    expect(deps.chamadas.preparar[0].itens[0].codigo_produto_erp).toBe('0004325')
    // Prévia nunca pode pedir bloqueio: o diagnóstico não altera estado no ERP.
    expect(deps.chamadas.preparar[0].bloquear_apos_criar).toBe(false)
  })

  test('--produto explícito tem precedência sobre o descoberto', async () => {
    const deps = criarDeps()
    await script.diagnosticar(
      opcoes(['--cliente-busca=maria', '--vendedor-busca=paula', '--produto=9999999']), deps,
    )
    expect(deps.chamadas.preparar[0].itens[0].codigo_produto_erp).toBe('9999999')
  })

  test('ambiguidade de cliente NÃO é defeito: a prévia respondeu', async () => {
    const deps = criarDeps({
      respPreparar: { ...RESP_OK, data: { dados: { status: 'multiplos_clientes' } } },
    })
    const { exitCode, veredito } = await script.diagnosticar(
      opcoes(['--cliente-busca=maria', '--vendedor-busca=paula']), deps,
    )
    expect(exitCode).toBe(0)
    expect(veredito.provas.find((p) => p.nome === 'preparar').estado).toBe('ok')
  })
})

/* ------------------------------------------------------------------ *
 * veredito
 * ------------------------------------------------------------------ */

describe('veredito', () => {
  test('tudo saudável: exit 0 e nenhum impedimento', async () => {
    const deps = criarDeps()
    const { exitCode, veredito } = await script.diagnosticar(
      opcoes(['--cliente-busca=maria', '--vendedor-busca=paula']), deps,
    )
    expect(exitCode).toBe(0)
    expect(veredito.pronta).toBe(true)
    expect(saida(deps)).toContain('PRONTA PARA ORÇAR')
  })

  test('--json emite só o veredito, sem o relatório legível', async () => {
    const deps = criarDeps()
    await script.diagnosticar(opcoes(['--json']), deps)
    const texto = saida(deps)

    expect(texto).not.toContain('Diagnóstico do Orçamento WM')
    const parsed = JSON.parse(texto)
    expect(parsed.pronta).toBe(true)
    expect(Array.isArray(parsed.provas)).toBe(true)
    expect(texto).not.toContain(TELEFONE)
  })
})
