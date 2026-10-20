/**
 * Provisionamento do vínculo `company_id` → telefone autorizado da WM
 * (`scripts/wm-provisionar-empresa.js`).
 *
 * O que estes testes protegem, em ordem de gravidade:
 *   1. o telefone autorizado NUNCA aparece na saída nem em log — só os últimos 4 dígitos;
 *   2. nada é gravado sem `--confirmar`, e nada é gravado em `--dry-run`;
 *   3. argumento inválido (company_id, telefone fora de 8–30) morre ANTES de qualquer chamada;
 *   4. recusa da WM (403/401/sem configuração) não grava vínculo nenhum;
 *   5. `--sem-validar` grava, mas com `validacao_status = 'nao_validado'`.
 *
 * Nenhuma chamada de rede e nenhum banco: as dependências entram por parâmetro
 * (`provisionar(opts, deps)`), como no `scripts/reparar-midia-sem-link.js`.
 */

const script = require('../scripts/wm-provisionar-empresa')

const TELEFONE = '5534991847800'
const ULTIMOS4 = '7800'

/** Argumentos de um provisionamento completo e válido; `extra` sobrescreve/acrescenta. */
function args(extra = []) {
  return ['--company-id=7', `--telefone=${TELEFONE}`, '--por=suporte/miguel', ...extra]
}

function opcoes(extra = []) {
  const { erros, opts } = script.parseArgs(args(extra))
  expect(erros).toEqual([])
  return opts
}

/**
 * Dependências falsas, com registro de tudo que foi chamado. Por padrão: empresa existe,
 * nenhum vínculo gravado ainda, WM autoriza.
 */
function criarDeps({
  empresa = { id: 7, nome: 'Empresa Piloto', ativo: true },
  erroEmpresa = null,
  configAntes = null,
  telefoneGravado = null,
  respostaWm = { ok: true, status: 200, data: { autorizado: true }, erroWm: null, transporte: null, configuracaoInvalida: null },
  erroSalvar = null,
} = {}) {
  const chamadas = { ordem: [], filtros: [], validarAcesso: [], salvarConfig: [], registrarValidacao: [] }

  const vazio = {
    configurado: false,
    ativo: false,
    telefone_ultimos4: null,
    validacao_status: 'nao_validado',
    validado_em: null,
    atualizado_em: null,
  }

  const estado = { ...(configAntes || vazio) }

  const deps = {
    linhasLog: [],
    chamadas,
    log: (texto) => { deps.linhasLog.push(String(texto)) },
    supabase: {
      from: (tabela) => {
        chamadas.ordem.push(`from:${tabela}`)
        return {
          select() { return this },
          eq(coluna, valor) { chamadas.filtros.push([coluna, valor]); return this },
          maybeSingle: () => Promise.resolve({ data: erroEmpresa ? null : empresa, error: erroEmpresa }),
        }
      },
    },
    wmApiClient: {
      validarAcesso: (payload) => {
        chamadas.ordem.push('validarAcesso')
        chamadas.validarAcesso.push(payload)
        return Promise.resolve(respostaWm)
      },
    },
    configService: {
      obterConfigPublica: () => Promise.resolve({ ...estado }),
      obterTelefoneAutorizado: () => Promise.resolve(telefoneGravado),
      salvarConfig: (patch) => {
        chamadas.ordem.push('salvarConfig')
        chamadas.salvarConfig.push(patch)
        if (erroSalvar) return Promise.resolve({ error: erroSalvar })
        if (patch.telefone_autorizado !== undefined) {
          estado.telefone_ultimos4 = String(patch.telefone_autorizado).replace(/\D+/g, '').slice(-4)
          estado.validacao_status = 'nao_validado'
          estado.validado_em = null
        }
        if (patch.ativo !== undefined) estado.ativo = !!patch.ativo
        estado.configurado = true
        return Promise.resolve({ config: { ...estado } })
      },
      registrarValidacao: ({ status }) => {
        chamadas.ordem.push('registrarValidacao')
        chamadas.registrarValidacao.push(status)
        estado.validacao_status = status
        estado.validado_em = '2026-10-20T12:00:00.000Z'
        return Promise.resolve({ config: { ...estado } })
      },
    },
  }
  return deps
}

/** Tudo que o script emitiu, numa string só. */
function saida(resultado, deps) {
  return [...resultado.linhas, ...deps.linhasLog].join('\n')
}

/** O telefone completo (e qualquer prefixo revelador) não pode estar em lugar nenhum. */
function expectSemTelefone(texto) {
  expect(texto).not.toContain(TELEFONE)
  expect(texto).not.toContain(TELEFONE.slice(0, 9))
  expect(texto).not.toContain(TELEFONE.slice(0, 5))
}

/* ------------------------------------------------------------------ *
 * parseArgs — morre antes de qualquer chamada
 * ------------------------------------------------------------------ */

describe('parseArgs — argumentos recusados sem tocar em rede ou banco', () => {
  it('company_id ausente, zero, negativo ou não numérico é recusado', () => {
    for (const valor of [null, '0', '-3', 'abc', '1.5', '']) {
      const argv = valor === null
        ? [`--telefone=${TELEFONE}`, '--por=x']
        : [`--company-id=${valor}`, `--telefone=${TELEFONE}`, '--por=x']
      const { erros, opts } = script.parseArgs(argv)
      expect(erros.length).toBeGreaterThan(0)
      expect(opts.companyId).toBeNull()
    }
  })

  it('telefone fora de 8–30 caracteres é recusado, e o valor não é ecoado no erro', () => {
    for (const telefone of ['1234567', '1'.repeat(31)]) {
      const { erros, opts } = script.parseArgs(['--company-id=7', `--telefone=${telefone}`, '--por=x'])
      expect(erros.length).toBeGreaterThan(0)
      expect(erros.join(' ')).toContain('8 a 30')
      expect(erros.join(' ')).not.toContain(telefone)
      expect(opts.telefone).toBeNull()
    }
  })

  it('aceita os limites 8 e 30 caracteres', () => {
    for (const telefone of ['1'.repeat(8), '1'.repeat(30)]) {
      const { erros, opts } = script.parseArgs(['--company-id=7', `--telefone=${telefone}`, '--por=x'])
      expect(erros).toEqual([])
      expect(opts.telefone).toBe(telefone)
    }
  })

  it('--por é obrigatório e não aceita flag sem valor', () => {
    expect(script.parseArgs(['--company-id=7', `--telefone=${TELEFONE}`]).erros.join(' ')).toContain('--por')
    expect(script.parseArgs(['--company-id=7', `--telefone=${TELEFONE}`, '--por']).erros.join(' ')).toContain('--por')
  })

  it('--ativar e --desativar juntos são recusados', () => {
    const { erros } = script.parseArgs([...args(), '--ativar', '--desativar'])
    expect(erros.join(' ')).toContain('mutuamente exclusivos')
  })

  it('sem telefone, sem --ativar e sem --desativar não há nada a fazer', () => {
    const { erros } = script.parseArgs(['--company-id=7', '--por=x'])
    expect(erros.join(' ')).toContain('Nada a fazer')
  })

  it('opção desconhecida e argumento solto são recusados (não ignorados em silêncio)', () => {
    expect(script.parseArgs([...args(), '--forcar']).erros.join(' ')).toContain('--forcar')
    expect(script.parseArgs([...args(), 'confirmar']).erros.join(' ')).toContain('Argumento solto')
  })

  it('nasce sem gravar e sem ativar: confirmar, dry-run, ativar e sem-validar são todos false', () => {
    const opts = opcoes()
    expect(opts.confirmar).toBe(false)
    expect(opts.dryRun).toBe(false)
    expect(opts.ativar).toBe(false)
    expect(opts.semValidar).toBe(false)
  })

  it('main() recusa argumento inválido sem construir dependência nenhuma', async () => {
    const erroSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(script.main(['--company-id=0', '--por=x', `--telefone=${TELEFONE}`])).resolves.toBe(1)
    const impresso = erroSpy.mock.calls.flat().join('\n')
    expect(impresso).toContain('--company-id')
    expectSemTelefone(impresso)
    erroSpy.mockRestore()
  })
})

/* ------------------------------------------------------------------ *
 * classificarValidacao — a WM só autoriza com 200 + autorizado:true
 * ------------------------------------------------------------------ */

describe('classificarValidacao', () => {
  it('200 com autorizado:true é o ÚNICO caso autorizado', () => {
    expect(script.classificarValidacao({ ok: true, status: 200, data: { autorizado: true } }).status).toBe('autorizado')
    expect(script.classificarValidacao({ ok: true, status: 200, data: { autorizado: false } }).status).toBe('resposta_invalida')
    expect(script.classificarValidacao({ ok: true, status: 200, data: {} }).status).toBe('resposta_invalida')
    expect(script.classificarValidacao({ ok: true, status: 200, data: null }).status).toBe('resposta_invalida')
  })

  it('distingue configuração ausente, indisponibilidade, 403, 401 e 400', () => {
    expect(script.classificarValidacao({ configuracaoInvalida: 'base_url_ausente' }).status).toBe('config')
    expect(script.classificarValidacao({ transporte: 'timeout' }).status).toBe('indisponivel')
    expect(script.classificarValidacao({ ok: false, status: 403 }).status).toBe('negado')
    expect(script.classificarValidacao({ ok: false, status: 401 }).status).toBe('credencial')
    expect(script.classificarValidacao({ ok: false, status: 400 }).status).toBe('payload')
    expect(script.classificarValidacao({ ok: false, status: 500 }).status).toBe('erro')
    expect(script.classificarValidacao(null).status).toBe('erro')
  })
})

/* ------------------------------------------------------------------ *
 * provisionar — gravação
 * ------------------------------------------------------------------ */

describe('provisionar — nada é gravado sem autorização explícita', () => {
  it('--dry-run valida tudo e NÃO grava', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--dry-run', '--confirmar']), deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.validarAcesso).toHaveLength(1)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
    expect(deps.chamadas.registrarValidacao).toHaveLength(0)
    expect(saida(r, deps)).toContain('DRY-RUN: nada foi gravado.')
  })

  it('sem --confirmar NÃO grava, e diz o que falta', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(), deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
    expect(saida(r, deps)).toContain('falta --confirmar')
  })

  it('com --confirmar grava DESATIVADO por padrão e registra a validação DEPOIS do salvarConfig', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.salvarConfig).toHaveLength(1)
    expect(deps.chamadas.salvarConfig[0]).toMatchObject({
      company_id: 7,
      telefone_autorizado: TELEFONE,
      ativo: false,
      provisionado_por: 'suporte/miguel',
    })
    // salvarConfig zera a validação quando o telefone muda: registrar antes perderia o status.
    expect(deps.chamadas.ordem.indexOf('salvarConfig'))
      .toBeLessThan(deps.chamadas.ordem.indexOf('registrarValidacao'))
    expect(deps.chamadas.registrarValidacao).toEqual(['autorizado'])
    expect(r.resumo).toMatchObject({ ativo: false, validacao_status: 'autorizado', telefone_ultimos4: ULTIMOS4 })
  })

  it('--ativar é o segundo passo: liga sem trocar o telefone e revalida o que já está gravado', async () => {
    const deps = criarDeps({
      configAntes: { configurado: true, ativo: false, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado', validado_em: null, atualizado_em: null },
      telefoneGravado: TELEFONE,
    })
    const { erros, opts } = script.parseArgs(['--company-id=7', '--por=suporte/miguel', '--ativar', '--confirmar'])
    expect(erros).toEqual([])
    const r = await script.provisionar(opts, deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.validarAcesso).toEqual([{ telefone: TELEFONE }])
    expect(deps.chamadas.salvarConfig[0].telefone_autorizado).toBeUndefined()
    expect(deps.chamadas.salvarConfig[0].ativo).toBe(true)
    expect(r.resumo.ativo).toBe(true)
    expectSemTelefone(saida(r, deps))
  })

  it('trocar o telefone de uma empresa ativa DESATIVA a empresa (ativar é passo separado)', async () => {
    const deps = criarDeps({
      configAntes: { configurado: true, ativo: true, telefone_ultimos4: '1111', validacao_status: 'autorizado', validado_em: null, atualizado_em: null },
      telefoneGravado: '5511999990000',
    })
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(deps.chamadas.salvarConfig[0].ativo).toBe(false)
    expect(r.resumo.ativo).toBe(false)
  })

  it('--desativar não apaga: só muda ativo para false, preservando o vínculo', async () => {
    const deps = criarDeps({
      configAntes: { configurado: true, ativo: true, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado', validado_em: null, atualizado_em: null },
      telefoneGravado: TELEFONE,
    })
    const { opts } = script.parseArgs(['--company-id=7', '--por=suporte/miguel', '--desativar', '--sem-validar', '--confirmar'])
    const r = await script.provisionar(opts, deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.validarAcesso).toHaveLength(0)
    expect(deps.chamadas.salvarConfig[0]).toMatchObject({ company_id: 7, ativo: false })
    expect(deps.chamadas.salvarConfig[0].telefone_autorizado).toBeUndefined()
    expect(r.resumo.telefone_ultimos4).toBe(ULTIMOS4)
  })
})

describe('provisionar — pré-condições', () => {
  it('empresa inexistente no ZapERP é recusada antes de chamar a WM', async () => {
    const deps = criarDeps({ empresa: null })
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(r.exitCode).toBe(1)
    expect(deps.chamadas.validarAcesso).toHaveLength(0)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
    expect(saida(r, deps)).toContain('não existe no ZapERP')
  })

  it('erro de leitura da tabela empresas não vira gravação', async () => {
    const deps = criarDeps({ erroEmpresa: { message: 'timeout' } })
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(r.exitCode).toBe(1)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
  })

  it('a consulta da empresa filtra por id (isolamento app-layer explícito)', async () => {
    const deps = criarDeps()
    await script.provisionar(opcoes(['--dry-run']), deps)
    expect(deps.chamadas.filtros).toEqual([['id', 7]])
  })

  it('sem --telefone e sem vínculo gravado, exige --telefone', async () => {
    const deps = criarDeps()
    const { opts } = script.parseArgs(['--company-id=7', '--por=x', '--ativar', '--confirmar'])
    const r = await script.provisionar(opts, deps)
    expect(r.exitCode).toBe(1)
    expect(saida(r, deps)).toContain('--telefone')
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
  })
})

describe('provisionar — recusa da WM nunca grava vínculo', () => {
  const casos = [
    ['403 (contato não autorizado)', { ok: false, status: 403 }, 'NEGOU'],
    ['401 (credencial)', { ok: false, status: 401 }, 'ZAPERP_API_TOKEN'],
    ['sem configuração', { configuracaoInvalida: 'base_url_ausente' }, 'não configurada'],
    ['timeout', { transporte: 'timeout' }, 'não respondeu'],
    ['200 fora do contrato', { ok: true, status: 200, data: { autorizado: 'sim' } }, 'fora do contrato'],
  ]

  it.each(casos)('%s → exit 1, nada gravado', async (_nome, respostaWm, trecho) => {
    const deps = criarDeps({ respostaWm })
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(r.exitCode).toBe(1)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
    expect(deps.chamadas.registrarValidacao).toHaveLength(0)
    expect(saida(r, deps)).toContain(trecho)
    expectSemTelefone(saida(r, deps))
  })

  it('sem configuração da WM, em --dry-run, dá mensagem clara e aponta o --sem-validar', async () => {
    const deps = criarDeps({ respostaWm: { configuracaoInvalida: 'token_ausente' } })
    const r = await script.provisionar(opcoes(['--dry-run']), deps)
    expect(r.exitCode).toBe(1)
    const texto = saida(r, deps)
    expect(texto).toContain('WM_API_BASE_URL')
    expect(texto).toContain('--sem-validar')
    expect(texto).not.toMatch(/at [\w.]+ \(/) // nada de stack trace
  })
})

describe('provisionar — --sem-validar', () => {
  it('grava sem chamar a WM, com validacao_status = nao_validado, e avisa em maiúsculas', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--sem-validar', '--confirmar']), deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.validarAcesso).toHaveLength(0)
    expect(deps.chamadas.salvarConfig).toHaveLength(1)
    expect(deps.chamadas.registrarValidacao).toHaveLength(0)
    expect(r.resumo.validacao_status).toBe('nao_validado')
    const texto = saida(r, deps)
    expect(texto).toContain('--SEM-VALIDAR: A VALIDAÇÃO CONTRA A WM FOI PULADA.')
    expect(texto).toContain('PRECISA SER VALIDADO ANTES DE ATIVAR')
  })

  it('--sem-validar continua respeitando --confirmar', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--sem-validar']), deps)
    expect(r.exitCode).toBe(0)
    expect(deps.chamadas.salvarConfig).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Segredo: o telefone completo não sai, em nenhum caminho
 * ------------------------------------------------------------------ */

describe('o telefone autorizado nunca sai do servidor', () => {
  it('não aparece na saída de nenhum dos caminhos, e o resumo mostra só os últimos 4', async () => {
    const caminhos = [
      ['--dry-run'],
      [],
      ['--confirmar'],
      ['--sem-validar', '--confirmar'],
    ]
    for (const extra of caminhos) {
      const deps = criarDeps()
      const r = await script.provisionar(opcoes(extra), deps)
      const texto = saida(r, deps)
      expectSemTelefone(texto)
      expect(texto).toContain(`****${ULTIMOS4}`)
      if (r.resumo) {
        expect(r.resumo.telefone_ultimos4).toBe(ULTIMOS4)
        expect(JSON.stringify(r.resumo)).not.toContain(TELEFONE.slice(0, 9))
      }
    }
  })

  it('não aparece em console.log/warn/error quando o script usa o logger padrão', async () => {
    const spies = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    }
    const deps = criarDeps()
    delete deps.log // força o console.log padrão de dentro de provisionar
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    const impresso = [
      ...spies.log.mock.calls.flat(),
      ...spies.warn.mock.calls.flat(),
      ...spies.error.mock.calls.flat(),
    ].map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n')
    for (const s of Object.values(spies)) s.mockRestore()
    expect(r.exitCode).toBe(0)
    expectSemTelefone(impresso)
    expect(impresso).toContain(`****${ULTIMOS4}`)
  })

  it('a falha de gravação não ecoa o telefone', async () => {
    const deps = criarDeps({ erroSalvar: 'Não foi possível salvar a configuração.' })
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(r.exitCode).toBe(1)
    expectSemTelefone(saida(r, deps))
  })
})

/* ------------------------------------------------------------------ *
 * O aviso da pendência 13 é obrigatório
 * ------------------------------------------------------------------ */

describe('aviso de vínculo de tenant (pendência 13)', () => {
  it('diz, em texto, que a WM não prova o vínculo com a empresa do ZapERP', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--dry-run']), deps)
    const texto = saida(r, deps)
    expect(texto).toContain('NÃO prova')
    expect(texto).toContain('MESMA empresa')
    expect(texto).toContain('conferência do vínculo é HUMANA')
  })

  it('aparece também no caminho que grava', async () => {
    const deps = criarDeps()
    const r = await script.provisionar(opcoes(['--confirmar']), deps)
    expect(saida(r, deps)).toContain('conferência do vínculo é HUMANA')
  })
})

/* ------------------------------------------------------------------ *
 * Nenhuma chamada de rede real
 * ------------------------------------------------------------------ */

describe('o teste não faz rede', () => {
  it('o cliente WM usado é o falso: fetch global nunca é chamado', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('rede não permitida em teste')
    })
    const deps = criarDeps()
    await script.provisionar(opcoes(['--confirmar']), deps)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('o wmApiClient real expõe validarAcesso apontando para o caminho do openapi.yaml', () => {
    const client = require('../services/wm/wmApiClient')
    expect(typeof client.validarAcesso).toBe('function')
    expect(client.WM_PATHS.ACESSO_VALIDAR).toBe('/api/v1/assistente/acesso/validar')
  })
})

/* ------------------------------------------------------------------ *
 * O segredo só é lido quando há validação a fazer
 * ------------------------------------------------------------------ */

describe('leitura do telefone gravado', () => {
  it('--desativar --sem-validar não lê o telefone do banco', async () => {
    const deps = criarDeps({
      configAntes: { configurado: true, ativo: true, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado', validado_em: null, atualizado_em: null },
      telefoneGravado: TELEFONE,
    })
    const leituras = []
    deps.configService.obterTelefoneAutorizado = () => { leituras.push(1); return Promise.resolve(TELEFONE) }
    const { opts } = script.parseArgs(['--company-id=7', '--por=x', '--desativar', '--sem-validar', '--confirmar'])
    const r = await script.provisionar(opts, deps)
    expect(r.exitCode).toBe(0)
    expect(leituras).toHaveLength(0)
    expect(deps.chamadas.salvarConfig[0].ativo).toBe(false)
  })

  it('--ativar precisa do telefone gravado e o lê uma única vez', async () => {
    const deps = criarDeps({
      configAntes: { configurado: true, ativo: false, telefone_ultimos4: ULTIMOS4, validacao_status: 'autorizado', validado_em: null, atualizado_em: null },
      telefoneGravado: TELEFONE,
    })
    const leituras = []
    deps.configService.obterTelefoneAutorizado = () => { leituras.push(1); return Promise.resolve(TELEFONE) }
    const { opts } = script.parseArgs(['--company-id=7', '--por=x', '--ativar', '--confirmar'])
    await script.provisionar(opts, deps)
    expect(leituras).toHaveLength(1)
  })
})
