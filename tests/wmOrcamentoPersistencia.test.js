/**
 * Persistência local do orçamento WM (doc 36, seção 6):
 *  · isolamento — toda query das 2 tabelas novas filtra company_id explicitamente
 *    (SERVICE_ROLE bypassa RLS; não existe proteção de banco compensando filtro ausente);
 *  · o telefone autorizado nunca sai do servidor — só telefone_ultimos4;
 *  · auditoria com entidade='wm_orcamento', entidade_id=null e o UUID em detalhes_json
 *    (entidade_id é integer; o helper é best-effort e engoliria o erro em silêncio).
 */
const fs = require('fs')
const path = require('path')

const supabase = require('../config/supabase')
const auditoriaLog = require('../helpers/auditoriaLog')
const configService = require('../services/wm/wmIntegrationConfigService')
const { registrarEventoOrcamento, EVENTOS, ENTIDADE } = require('../services/wm/wmOrcamentoAuditoria')

const RAIZ = path.join(__dirname, '..')
const TABELAS_NOVAS = ['wm_orcamento_integracoes', 'wm_orcamento_operacoes']

/** Encadeamento Supabase mockado, registrando tabela, filtros e payloads. */
function mockSupabase({ data = null, error = null } = {}) {
  const espiao = { tabelas: [], filtros: [], inserts: [], updates: [] }
  supabase.from.mockImplementation((tabela) => {
    espiao.tabelas.push(tabela)
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn((coluna, valor) => { espiao.filtros.push([coluna, valor]); return chain }),
      insert: jest.fn((payload) => { espiao.inserts.push(payload); return chain }),
      update: jest.fn((payload) => { espiao.updates.push(payload); return chain }),
      maybeSingle: jest.fn().mockResolvedValue({ data, error }),
    }
    return chain
  })
  return espiao
}

beforeEach(() => {
  supabase.from.mockReset()
})

// =============================================================================
// Isolamento por company_id — varredura do código-fonte
// =============================================================================
describe('isolamento: toda query das tabelas novas filtra company_id', () => {
  function arquivosJs(dir, acc = []) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue
      const completo = path.join(dir, entrada.name)
      if (entrada.isDirectory()) arquivosJs(completo, acc)
      else if (entrada.name.endsWith('.js')) acc.push(completo)
    }
    return acc
  }

  const alvos = ['services', 'helpers', 'middleware', 'controllers', 'routes', 'workers']
    .map((d) => path.join(RAIZ, d))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => arquivosJs(d))

  it('encontra pelo menos um ponto de acesso para varrer (o teste não passa por vazio)', () => {
    const comAcesso = alvos.filter((f) =>
      TABELAS_NOVAS.some((t) => fs.readFileSync(f, 'utf8').includes(`'${t}'`))
    )
    expect(comAcesso.length).toBeGreaterThan(0)
  })

  it.each(TABELAS_NOVAS)('%s: nenhum .from() sem company_id por perto', (tabela) => {
    const faltando = []
    for (const arquivo of alvos) {
      const src = fs.readFileSync(arquivo, 'utf8')
      const marcador = `.from('${tabela}')`
      let i = src.indexOf(marcador)
      while (i !== -1) {
        // Recorta até o próximo .from( (ou 700 chars) para não cruzar statements.
        let fim = Math.min(src.length, i + 700)
        const proximo = src.indexOf('.from(', i + marcador.length)
        if (proximo !== -1 && proximo < fim) fim = proximo
        const trecho = src.slice(i, fim)
        const temFiltro = /\.eq\(\s*['"]company_id['"]/.test(trecho)
        const temColunaNoPayload = /company_id\s*:/.test(trecho)
        if (!temFiltro && !temColunaNoPayload) {
          faltando.push(`${path.relative(RAIZ, arquivo)} (offset ${i})`)
        }
        i = src.indexOf(marcador, i + marcador.length)
      }
    }
    expect(faltando).toEqual([])
  })
})

// =============================================================================
// wmIntegrationConfigService
// =============================================================================
describe('wmIntegrationConfigService — leitura', () => {
  it('lê filtrando company_id na tabela certa', async () => {
    const espiao = mockSupabase({ data: { company_id: 7, ativo: true, telefone_ultimos4: '4321' } })
    await configService.obterConfigInterna(7)
    expect(espiao.tabelas).toEqual(['wm_orcamento_integracoes'])
    expect(espiao.filtros).toEqual([['company_id', 7]])
  })

  it('company_id inválido não chega ao banco', async () => {
    const espiao = mockSupabase({ data: null })
    for (const cid of [undefined, null, 0, -3, 'x']) {
      await expect(configService.obterConfigInterna(cid)).resolves.toBeNull()
    }
    expect(espiao.tabelas).toEqual([])
  })

  it('erro de leitura vira null e não propaga a mensagem do banco', async () => {
    mockSupabase({ data: null, error: { message: 'erro contendo 5511999998888' } })
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(configService.obterConfigInterna(7)).resolves.toBeNull()
    const logado = aviso.mock.calls.flat().join(' ')
    expect(logado).not.toMatch(/5511999998888/)
    aviso.mockRestore()
  })
})

describe('wmIntegrationConfigService — o telefone autorizado não sai do servidor', () => {
  const LINHA = {
    id: 1,
    company_id: 7,
    ativo: true,
    telefone_autorizado: '5511999998888',
    telefone_ultimos4: '8888',
    validacao_status: 'autorizado',
    validado_em: '2026-10-20T12:00:00.000Z',
    provisionado_por: 'suporte',
    atualizado_em: '2026-10-20T12:00:00.000Z',
  }

  it('sanitizarConfig devolve só o recorte exibível', () => {
    const publico = configService.sanitizarConfig(LINHA)
    expect(JSON.stringify(publico)).not.toMatch(/5511999998888/)
    expect(publico).toEqual({
      configurado: true,
      ativo: true,
      telefone_ultimos4: '8888',
      validacao_status: 'autorizado',
      validado_em: '2026-10-20T12:00:00.000Z',
      atualizado_em: '2026-10-20T12:00:00.000Z',
    })
    expect(publico).not.toHaveProperty('telefone_autorizado')
    expect(publico).not.toHaveProperty('provisionado_por')
    expect(publico).not.toHaveProperty('id')
  })

  it('obterConfigPublica nunca devolve o telefone, mesmo com a linha completa no banco', async () => {
    mockSupabase({ data: LINHA })
    const publico = await configService.obterConfigPublica(7)
    expect(JSON.stringify(publico)).not.toMatch(/5511999998888/)
    expect(publico.telefone_ultimos4).toBe('8888')
  })

  it('empresa sem linha devolve configurado=false, não erro', async () => {
    mockSupabase({ data: null })
    expect(await configService.obterConfigPublica(7)).toEqual(expect.objectContaining({
      configurado: false, ativo: false, telefone_ultimos4: null,
    }))
  })

  it('obterTelefoneAutorizado é o único caminho para o valor completo (uso server-side)', async () => {
    mockSupabase({ data: LINHA })
    await expect(configService.obterTelefoneAutorizado(7)).resolves.toBe('5511999998888')
  })

  it('ultimos4 ignora máscara e recusa telefone curto demais', () => {
    expect(configService.ultimos4('+55 (11) 99999-8888')).toBe('8888')
    expect(configService.ultimos4('123')).toBeNull()
    expect(configService.ultimos4('')).toBeNull()
    expect(configService.ultimos4(null)).toBeNull()
  })
})

describe('wmIntegrationConfigService — escrita', () => {
  it('insere com company_id no payload e deriva os últimos 4', async () => {
    const espiao = mockSupabase({ data: null }) // leitura prévia: não existe
    const r = await configService.salvarConfig({
      company_id: 7,
      telefone_autorizado: '+55 (11) 99999-8888',
      ativo: true,
      provisionado_por: 'suporte',
    })
    expect(r.error).toBeUndefined()
    expect(espiao.inserts).toHaveLength(1)
    expect(espiao.inserts[0]).toEqual(expect.objectContaining({
      company_id: 7,
      ativo: true,
      telefone_autorizado: '+55 (11) 99999-8888',
      telefone_ultimos4: '8888',
      validacao_status: 'nao_validado',
    }))
    expect(espiao.tabelas.every((t) => t === 'wm_orcamento_integracoes')).toBe(true)
  })

  it('atualiza filtrando company_id e invalida o cache da flag', async () => {
    const flag = require('../helpers/orcamentoWmFlag')
    const invalida = jest.spyOn(flag, 'invalidateOrcamentoWmCache')
    const espiao = mockSupabase({ data: { company_id: 7, ativo: false, telefone_ultimos4: '8888' } })
    const r = await configService.salvarConfig({ company_id: 7, ativo: false })
    expect(r.error).toBeUndefined()
    expect(espiao.updates).toHaveLength(1)
    expect(espiao.filtros).toContainEqual(['company_id', 7])
    expect(espiao.filtros.every(([coluna]) => coluna === 'company_id')).toBe(true)
    expect(invalida).toHaveBeenCalledWith(7)
    invalida.mockRestore()
  })

  it('trocar o telefone invalida a validação anterior', async () => {
    const espiao = mockSupabase({ data: { company_id: 7, ativo: true, telefone_ultimos4: '1111' } })
    await configService.salvarConfig({ company_id: 7, telefone_autorizado: '5511999997777' })
    expect(espiao.updates[0]).toEqual(expect.objectContaining({
      telefone_ultimos4: '7777',
      validacao_status: 'nao_validado',
      validado_em: null,
    }))
  })

  it('recusa company_id ausente, telefone vazio e telefone inválido', async () => {
    mockSupabase({ data: null })
    expect((await configService.salvarConfig({})).error).toMatch(/company_id/)
    expect((await configService.salvarConfig({ company_id: 7, telefone_autorizado: '' })).error).toMatch(/vazio/)
    expect((await configService.salvarConfig({ company_id: 7, telefone_autorizado: '12' })).error).toMatch(/inválido/)
  })

  it('primeiro provisionamento sem telefone é recusado', async () => {
    mockSupabase({ data: null })
    const r = await configService.salvarConfig({ company_id: 7, ativo: true })
    expect(r.error).toMatch(/telefone_autorizado obrigatório/)
  })
})

// =============================================================================
// Auditoria
// =============================================================================
describe('auditoria do orçamento WM', () => {
  const UUID = '6f1b1e2a-6f3f-4a4e-9c1b-2d0f1a3b4c5d'

  it('grava entidade=wm_orcamento, entidade_id=null e o UUID em detalhes_json.operacao_id', async () => {
    const inserts = []
    supabase.from.mockImplementation((tabela) => ({
      insert: jest.fn(async (payload) => { inserts.push({ tabela, payload }); return { data: null, error: null } }),
    }))

    await registrarEventoOrcamento({
      company_id: 7,
      usuario_id: 5,
      acao: EVENTOS.CRIADO,
      operacao_id: UUID,
      detalhes: { estado: 'CRIADO', comando_id: UUID, http_status: 200 },
    })

    expect(inserts).toHaveLength(1)
    expect(inserts[0].tabela).toBe('auditoria_log')
    const linha = inserts[0].payload
    expect(linha.entidade).toBe(ENTIDADE)
    expect(linha.entidade).toBe('wm_orcamento')
    // entidade_id é INTEGER na tabela: o UUID ali faria o insert falhar em silêncio.
    expect(linha.entidade_id).toBeNull()
    expect(linha.detalhes_json.operacao_id).toBe(UUID)
    expect(linha.company_id).toBe(7)
    expect(linha.usuario_id).toBe(5)
    expect(linha.acao).toBe('wm_orcamento_criado')
  })

  it('o insert chega ao banco de verdade (o helper é best-effort e engoliria um erro)', async () => {
    const registrar = jest.spyOn(auditoriaLog, 'registrar')
    const erros = []
    supabase.from.mockImplementation(() => ({
      insert: jest.fn(async () => ({ data: null, error: null })),
    }))
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args) => erros.push(args.join(' ')))

    await registrarEventoOrcamento({ company_id: 7, acao: EVENTOS.PREPARADO, operacao_id: UUID })

    expect(registrar).toHaveBeenCalledTimes(1)
    expect(erros.filter((e) => e.includes('[auditoriaLog]'))).toEqual([])
    warn.mockRestore()
    registrar.mockRestore()
  })

  it('descarta campo fora da allowlist — segredo não entra na auditoria', async () => {
    const inserts = []
    supabase.from.mockImplementation(() => ({
      insert: jest.fn(async (payload) => { inserts.push(payload); return { data: null, error: null } }),
    }))

    await registrarEventoOrcamento({
      company_id: 7,
      acao: EVENTOS.FALHA_SEGURA,
      operacao_id: UUID,
      detalhes: {
        erro_codigo: 'WM_SINCRONIZADOR_OFFLINE',
        telefone_autorizado: '5511999998888',
        authorization: 'Bearer segredo',
        payload_criacao: { preco_confirmado: '10.00' },
        cpf: '00000000000',
        body: 'cru',
      },
    })

    const detalhes = inserts[0].detalhes_json
    expect(detalhes).toEqual({ erro_codigo: 'WM_SINCRONIZADOR_OFFLINE', operacao_id: UUID })
    const serializado = JSON.stringify(inserts[0])
    expect(serializado).not.toMatch(/5511999998888|Bearer|preco_confirmado|00000000000/)
  })

  it('sem operacao_id não inventa a chave', async () => {
    const inserts = []
    supabase.from.mockImplementation(() => ({
      insert: jest.fn(async (payload) => { inserts.push(payload); return { data: null, error: null } }),
    }))
    await registrarEventoOrcamento({ company_id: 7, acao: EVENTOS.CONFIG_VALIDADA, detalhes: { validacao_status: 'autorizado' } })
    expect(inserts[0].detalhes_json).toEqual({ validacao_status: 'autorizado' })
    expect(inserts[0].entidade_id).toBeNull()
  })

  it('os 6 eventos da seção 6 existem com o prefixo wm_orcamento_', () => {
    expect(Object.values(EVENTOS).sort()).toEqual([
      'wm_orcamento_config_validada',
      'wm_orcamento_confirmado',
      'wm_orcamento_criado',
      'wm_orcamento_falha_segura',
      'wm_orcamento_preparado',
      'wm_orcamento_resultado_incerto',
    ])
  })
})
