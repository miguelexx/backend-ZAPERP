/**
 * Middleware genérico de permissão por código do catálogo (doc 36, D7).
 * Semântica herdada de helpers/permissoesService.usuarioTemPermissao:
 * admin sempre passa → override explícito → padrão do perfil.
 */
const supabase = require('../config/supabase')
const requirePermissao = require('../middleware/requirePermissao')
const { PERMISSOES_CATALOGO, PERMISSOES_POR_CODIGO } = require('../helpers/permissoesCatalogo')

/**
 * Mocka a leitura de usuario_permissoes. O builder real é "thenable"; o mock global do
 * setup não é, então precisa ser montado aqui para que o override seja lido de verdade.
 */
function mockOverrides(linhas, espiao = null) {
  supabase.from.mockImplementation((tabela) => {
    if (espiao) espiao.tabelas.push(tabela)
    const resultado = Promise.resolve({ data: linhas, error: null })
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn((coluna, valor) => {
        if (espiao) espiao.filtros.push([coluna, valor])
        return chain
      }),
      then: (resolve, reject) => resultado.then(resolve, reject),
    }
    return chain
  })
}

function contexto(user) {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return { req: { user }, res, next: jest.fn() }
}

const ATENDENTE = { id: 5, company_id: 10, perfil: 'atendente' }
const SUPERVISOR = { id: 6, company_id: 10, perfil: 'supervisor' }
const ADMIN = { id: 1, company_id: 10, perfil: 'admin' }

beforeEach(() => {
  supabase.from.mockReset()
  mockOverrides([])
})

describe('catálogo — entradas de orçamento', () => {
  it('tem os 3 códigos PONTILHADOS (underscore cairia no fallback por role e sumiria o gate)', () => {
    for (const codigo of ['orcamentos.ver', 'orcamentos.criar', 'orcamentos.ver_historico_empresa']) {
      expect(PERMISSOES_POR_CODIGO[codigo]).toBeDefined()
      expect(codigo).toMatch(/^orcamentos\.[a-z_]+$/)
    }
  })

  it('aplica os perfis da tabela D7', () => {
    expect(PERMISSOES_POR_CODIGO['orcamentos.ver'].perfis).toEqual(['admin', 'supervisor', 'atendente'])
    expect(PERMISSOES_POR_CODIGO['orcamentos.criar'].perfis).toEqual(['admin', 'supervisor', 'atendente'])
    expect(PERMISSOES_POR_CODIGO['orcamentos.ver_historico_empresa'].perfis).toEqual(['admin', 'supervisor'])
  })

  it('não cria orcamentos.configurar (provisionamento não é de admin de tenant)', () => {
    expect(PERMISSOES_POR_CODIGO['orcamentos.configurar']).toBeUndefined()
  })

  it('não introduz código duplicado no catálogo', () => {
    const codigos = PERMISSOES_CATALOGO.map((p) => p.codigo)
    expect(new Set(codigos).size).toBe(codigos.length)
  })
})

describe('requirePermissao — nega sem a permissão', () => {
  it('403 PERMISSAO_NEGADA para atendente sem o padrão do perfil', async () => {
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver_historico_empresa')(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PERMISSAO_NEGADA',
      permissao: 'orcamentos.ver_historico_empresa',
    }))
  })

  it('403 quando o override NEGA algo que o perfil teria por padrão', async () => {
    mockOverrides([{ permissao_codigo: 'orcamentos.criar', concedido: false }])
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.criar')(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('403 para código fora do catálogo (não-admin)', async () => {
    const { req, res, next } = contexto(SUPERVISOR)
    await requirePermissao('orcamentos_criar')(req, res, next) // underscore: o bug que D7 evita
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('403 sem req.user, sem company_id e sem id — nunca assume empresa', async () => {
    for (const user of [undefined, {}, { id: 5 }, { company_id: 10 }]) {
      const { req, res, next } = contexto(user)
      await requirePermissao('orcamentos.ver')(req, res, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(403)
    }
  })

  it('403 quando a leitura dos overrides lança — fail-closed', async () => {
    supabase.from.mockImplementation(() => { throw new Error('banco fora') })
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver')(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('não vaza detalhe interno na resposta', async () => {
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver_historico_empresa')(req, res, next)
    const corpo = res.json.mock.calls[0][0]
    expect(Object.keys(corpo).sort()).toEqual(['code', 'error', 'permissao'])
    expect(corpo.error).not.toMatch(/sql|supabase|undefined/i)
  })
})

describe('requirePermissao — aceita', () => {
  it('passa com o padrão do perfil', async () => {
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('passa com OVERRIDE CONCEDIDO para quem o perfil não daria', async () => {
    mockOverrides([{ permissao_codigo: 'orcamentos.ver_historico_empresa', concedido: true }])
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver_historico_empresa')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('lê os overrides filtrando usuario_id E company_id', async () => {
    const espiao = { tabelas: [], filtros: [] }
    mockOverrides([], espiao)
    const { req, res, next } = contexto(ATENDENTE)
    await requirePermissao('orcamentos.ver')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(espiao.tabelas).toEqual(['usuario_permissoes'])
    expect(espiao.filtros).toEqual([['usuario_id', 5], ['company_id', 10]])
  })
})

describe('requirePermissao — admin', () => {
  it('passa sempre, inclusive com override negado e com código fora do catálogo', async () => {
    mockOverrides([{ permissao_codigo: 'orcamentos.criar', concedido: false }])
    for (const codigo of ['orcamentos.ver', 'orcamentos.criar', 'orcamentos.ver_historico_empresa', 'inexistente.qualquer']) {
      const { req, res, next } = contexto(ADMIN)
      await requirePermissao(codigo)(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    }
  })

  it('não consulta o banco para admin', async () => {
    const { req, res, next } = contexto(ADMIN)
    await requirePermissao('orcamentos.criar')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('requirePermissao — construção', () => {
  it('recusa código vazio já na montagem da rota (erro em boot, não em runtime)', () => {
    expect(() => requirePermissao('')).toThrow(/obrigatório/)
    expect(() => requirePermissao(null)).toThrow(/obrigatório/)
    expect(() => requirePermissao(undefined)).toThrow(/obrigatório/)
  })

  it('devolve um middleware express de 3 argumentos', () => {
    const mw = requirePermissao('orcamentos.ver')
    expect(typeof mw).toBe('function')
    expect(mw.length).toBe(3)
  })
})
