/**
 * Gate do módulo Orçamento WM: env global E empresa ativa, fail-closed dos dois lados
 * (doc 36, D2). Cobre também o middleware requireOrcamentoWm.
 */
const supabase = require('../config/supabase')
const flag = require('../helpers/orcamentoWmFlag')
const requireOrcamentoWm = require('../middleware/requireOrcamentoWm')

const ENV_ANTERIOR = process.env.WM_ORCAMENTOS_ENABLED

/** Mock de uma leitura de wm_orcamento_integracoes, registrando o filtro aplicado. */
function mockLeitura({ data = null, error = null, espiao = null } = {}) {
  supabase.from.mockImplementation((tabela) => {
    if (espiao) espiao.tabelas.push(tabela)
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn(function (coluna, valor) {
        if (espiao) espiao.filtros.push([coluna, valor])
        return this
      }),
      maybeSingle: jest.fn().mockResolvedValue({ data, error }),
    }
  })
}

beforeEach(() => {
  flag.invalidateOrcamentoWmCache()
  jest.restoreAllMocks()
  supabase.from.mockReset()
})

afterAll(() => {
  if (ENV_ANTERIOR == null) delete process.env.WM_ORCAMENTOS_ENABLED
  else process.env.WM_ORCAMENTOS_ENABLED = ENV_ANTERIOR
  flag.invalidateOrcamentoWmCache()
})

describe('wmOrcamentosEnvHabilitado', () => {
  it('é false por omissão — o módulo nasce desligado', () => {
    delete process.env.WM_ORCAMENTOS_ENABLED
    expect(flag.wmOrcamentosEnvHabilitado()).toBe(false)
  })

  it('aceita só true/1; qualquer outro valor fica desligado', () => {
    for (const v of ['true', 'TRUE', ' true ', '1']) {
      process.env.WM_ORCAMENTOS_ENABLED = v
      expect(flag.wmOrcamentosEnvHabilitado()).toBe(true)
    }
    for (const v of ['false', '0', '', 'sim', 'yes', 'on']) {
      process.env.WM_ORCAMENTOS_ENABLED = v
      expect(flag.wmOrcamentosEnvHabilitado()).toBe(false)
    }
  })
})

describe('orcamentoWmHabilitado — as 4 combinações de env × empresa', () => {
  it('env OFF + empresa inativa = false', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'false'
    mockLeitura({ data: { ativo: false } })
    await expect(flag.orcamentoWmHabilitado(10)).resolves.toBe(false)
  })

  it('env OFF + empresa ATIVA = false (e nem consulta o banco)', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'false'
    mockLeitura({ data: { ativo: true } })
    await expect(flag.orcamentoWmHabilitado(10)).resolves.toBe(false)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('env ON + empresa inativa = false', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    mockLeitura({ data: { ativo: false } })
    await expect(flag.orcamentoWmHabilitado(10)).resolves.toBe(false)
  })

  it('env ON + empresa ATIVA = true', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    mockLeitura({ data: { ativo: true } })
    await expect(flag.orcamentoWmHabilitado(10)).resolves.toBe(true)
  })
})

describe('empresaOrcamentoWmAtivo — isolamento, fail-closed e cache', () => {
  beforeEach(() => { process.env.WM_ORCAMENTOS_ENABLED = 'true' })

  it('filtra por company_id explicitamente na tabela certa', async () => {
    const espiao = { tabelas: [], filtros: [] }
    mockLeitura({ data: { ativo: true }, espiao })
    await flag.empresaOrcamentoWmAtivo(7)
    expect(espiao.tabelas).toEqual(['wm_orcamento_integracoes'])
    expect(espiao.filtros).toEqual([['company_id', 7]])
  })

  it('empresa sem linha provisionada = false', async () => {
    mockLeitura({ data: null })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)
  })

  it('tabela ausente (migration não aplicada) = false', async () => {
    mockLeitura({ data: null, error: { message: 'relation "wm_orcamento_integracoes" does not exist' } })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)
  })

  it('erro transitório de leitura = false (fail-closed) e NÃO fica preso no cache', async () => {
    mockLeitura({ data: null, error: { message: 'timeout' } })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)

    mockLeitura({ data: { ativo: true } })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(true)
  })

  it('exceção na leitura = false, sem derrubar o chamador', async () => {
    supabase.from.mockImplementation(() => { throw new Error('conexão caiu') })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)
  })

  it('company_id inválido = false, sem tocar no banco', async () => {
    mockLeitura({ data: { ativo: true } })
    for (const cid of [undefined, null, 0, -1, 'abc', NaN]) {
      await expect(flag.empresaOrcamentoWmAtivo(cid)).resolves.toBe(false)
    }
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('cacheia por 20 s e invalida por empresa sem afetar a outra', async () => {
    mockLeitura({ data: { ativo: true } })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(true)
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(true)
    expect(supabase.from).toHaveBeenCalledTimes(1)

    await expect(flag.empresaOrcamentoWmAtivo(11)).resolves.toBe(true)
    expect(supabase.from).toHaveBeenCalledTimes(2)

    mockLeitura({ data: { ativo: false } })
    flag.invalidateOrcamentoWmCache(10)
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)
    await expect(flag.empresaOrcamentoWmAtivo(11)).resolves.toBe(true) // ainda do cache
  })

  it('entrada expirada do cache é relida', async () => {
    flag.primeOrcamentoWmCache(10, true, -1)
    mockLeitura({ data: { ativo: false } })
    await expect(flag.empresaOrcamentoWmAtivo(10)).resolves.toBe(false)
  })
})

describe('requireOrcamentoWm — fail-closed', () => {
  function resposta() {
    const res = {}
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    return res
  }

  it('deixa passar com env ON e empresa ativa', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    mockLeitura({ data: { ativo: true } })
    const res = resposta()
    const next = jest.fn()
    await requireOrcamentoWm({ user: { company_id: 10 } }, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('403 ORCAMENTO_WM_OFF com a empresa desativada', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    mockLeitura({ data: { ativo: false } })
    const res = resposta()
    const next = jest.fn()
    await requireOrcamentoWm({ user: { company_id: 10 } }, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORCAMENTO_WM_OFF' }))
  })

  it('403 quando a LEITURA DA FLAG FALHA — não deixa passar na dúvida', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    jest.spyOn(flag, 'orcamentoWmHabilitado').mockRejectedValue(new Error('banco fora'))
    const res = resposta()
    const next = jest.fn()
    await requireOrcamentoWm({ user: { company_id: 10 } }, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORCAMENTO_WM_OFF' }))
  })

  it('403 sem req.user (nunca assume empresa)', async () => {
    process.env.WM_ORCAMENTOS_ENABLED = 'true'
    mockLeitura({ data: { ativo: true } })
    const res = resposta()
    const next = jest.fn()
    await requireOrcamentoWm({}, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
