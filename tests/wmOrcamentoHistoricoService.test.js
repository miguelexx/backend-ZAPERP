'use strict'

/**
 * Página Integrações → aba Orçamentos. Prova o que importa para isolamento e para a tela:
 * company_id sempre filtrado, escopo forçado sem `ver_historico_empresa`, busca sem injeção de
 * filtro e projeção sem colunas sensíveis.
 */

const mockChamadas = []

function mockConstrutor(tabela, resposta) {
  const reg = { tabela, ops: [] }
  mockChamadas.push(reg)
  const b = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'or', 'order', 'range', 'limit', 'maybeSingle']) {
    b[m] = (...args) => {
      reg.ops.push([m, ...args])
      return b
    }
  }
  b.then = (ok, err) => Promise.resolve(resposta(reg)).then(ok, err)
  return b
}

const MOCK_LINHA = {
  id: '11111111-1111-4111-8111-111111111111',
  usuario_id: 7,
  conversa_id: 99,
  estado: 'CRIADO',
  previa_sanitizada: {
    cliente: { codigo_cliente_erp: '0000002', nome: 'VENDA AO CONSUMIDOR' },
    vendedor: { codigo_vendedor_erp: '002', nome: 'PAULA FERNANDA' },
    itens: [{ codigo_produto_erp: '1', descricao: 'PISO', quantidade: '2.000', preco_unitario: '18.42', valor_total: '36.84' }],
    valor_produtos: '36.84',
    valor_total: '36.84',
  },
  wm_resultado_sanitizado: { codigo_pedido_erp: '123456', valor_total: '36.84', bloqueado: true },
  erro_codigo_ultimo: null,
  tentativas: 1,
  criado_em: new Date().toISOString(),
  comando_id: 'NUNCA-DEVE-SAIR',
  payload_criacao: { segredo: true },
}

jest.mock('../config/supabase', () => ({
  from: (tabela) =>
    mockConstrutor(tabela, (reg) => {
      if (tabela === 'usuarios') return { data: [{ id: 7, nome: 'Ana' }] }
      if (tabela === 'conversas') return { data: [{ id: 99, cliente_id: 5, telefone: '5517999990000' }] }
      if (tabela === 'clientes') return { data: [{ id: 5, nome: 'Jorge', telefone: '5517999990000' }] }
      const sel = reg.ops.find((o) => o[0] === 'select')
      if (sel && sel[2] && sel[2].count) return { data: [MOCK_LINHA], count: 1 }
      return { data: [MOCK_LINHA] }
    }),
}))

jest.mock('../services/wm/wmIntegrationConfigService', () => ({
  obterConfigPublica: jest.fn(async () => ({ configurado: true, ativo: true, telefone_ultimos4: '9701' })),
}))

const svc = require('../services/wm/wmOrcamentoHistoricoService')

beforeEach(() => {
  mockChamadas.length = 0
})

describe('wmOrcamentoHistoricoService', () => {
  it('toda query filtra company_id', async () => {
    await svc.listarHistorico({ company_id: 3, usuario_id: 7, verEmpresa: true, query: {} })
    expect(mockChamadas.length).toBeGreaterThan(0)
    for (const c of mockChamadas) {
      expect(c.ops).toContainEqual(['eq', 'company_id', 3])
    }
  })

  it('sem ver_historico_empresa o escopo é forçado ao próprio usuário', async () => {
    const r = await svc.listarHistorico({ company_id: 3, usuario_id: 7, verEmpresa: false, query: { apenas_meus: '0' } })
    expect(r.resultado.escopo).toBe('proprio')
    const ops = mockChamadas.filter((c) => c.tabela === 'wm_orcamento_operacoes')
    for (const c of ops) expect(c.ops).toContainEqual(['eq', 'usuario_id', 7])
  })

  it('com ver_historico_empresa não filtra usuário, a menos que peça "apenas meus"', async () => {
    await svc.listarHistorico({ company_id: 3, usuario_id: 7, verEmpresa: true, query: {} })
    const ops = mockChamadas.filter((c) => c.tabela === 'wm_orcamento_operacoes')
    for (const c of ops) expect(c.ops.some((o) => o[0] === 'eq' && o[1] === 'usuario_id')).toBe(false)
  })

  it('a projeção não carrega comando_id nem payload', async () => {
    const r = await svc.listarHistorico({ company_id: 3, usuario_id: 7, verEmpresa: true, query: {} })
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/NUNCA-DEVE-SAIR|segredo|comando_id|payload/)
    const item = r.resultado.itens[0]
    expect(item.numero_erp).toBe('123456')
    expect(item.contato.nome).toBe('Jorge')
    expect(item.usuario.nome).toBe('Ana')
    expect(r.resultado.resumo.criados).toBe(1)
    expect(r.resultado.resumo.valor_criado).toBeCloseTo(36.84)
  })

  it('busca não injeta gramática de filtro', () => {
    expect(svc.termoBuscaSeguro('a,estado.eq.CRIADO)')).toBe('a estado.eq.CRIADO')
    expect(svc.termoBuscaSeguro("x*%'\\:y")).toBe('x y')
  })

  it('filtros estranhos caem no padrão', () => {
    const f = svc.normalizarFiltros({ estado: 'DROP', periodo: '9999', pagina: '-3', por_pagina: '1000' })
    expect(f).toMatchObject({ estado: 'registrados', periodo: '30', pagina: 1, porPagina: 50 })
  })

  it('company_id inválido é recusado', async () => {
    const r = await svc.listarHistorico({ company_id: null, usuario_id: 7, verEmpresa: true, query: {} })
    expect(r.ok).toBe(false)
  })
})
