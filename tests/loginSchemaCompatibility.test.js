describe('userController.login', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('consulta apenas uma coluna de senha por vez para compatibilidade com schemas legados', async () => {
    const selectCalls = []

    const loginChain = {
      select: jest.fn((cols) => {
        selectCalls.push(cols)
        if (String(cols).includes('password') || String(cols).includes('pass')) {
          return {
            ilike: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '42703', message: 'column does not exist' },
              }),
            })),
          }
        }
        return loginChain
      }),
      ilike: jest.fn(() => loginChain),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          id: 10,
          nome: 'Nicole',
          email: 'nicole@example.com',
          perfil: 'admin',
          departamento_id: null,
          company_id: 7,
          ativo: true,
          senha_hash: '$2a$10$hash',
        },
        error: null,
      }),
      eq: jest.fn(() => loginChain),
    }

    const empresasChain = {
      select: jest.fn(() => empresasChain),
      eq: jest.fn(() => empresasChain),
      maybeSingle: jest.fn().mockResolvedValue({ data: { separar_mensagens_disparadas: false }, error: null }),
    }

    jest.doMock('../config/supabase', () => ({
      from: jest.fn((table) => (table === 'empresas' ? empresasChain : loginChain)),
    }))
    jest.doMock('bcryptjs', () => ({
      hash: jest.fn(),
      compare: jest.fn().mockResolvedValue(true),
    }))
    jest.doMock('jsonwebtoken', () => ({
      sign: jest.fn().mockReturnValue('jwt-token'),
    }))
    jest.doMock('../helpers/crmEmpresaFlag', () => ({
      empresaCrmHabilitada: jest.fn().mockResolvedValue(true),
    }))
    jest.doMock('../helpers/usuarioDepartamentosHelper', () => ({
      obterDepartamentoIdsDoUsuario: jest.fn().mockResolvedValue([]),
    }))

    const { login } = require('../controllers/userController')
    const req = {
      body: { email: 'Nicole@Example.com', senha: '123456' },
    }
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }

    await login(req, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt-token' }))
    expect(selectCalls[0]).toContain('senha_hash')
    expect(selectCalls[0]).not.toContain('password')
    expect(selectCalls[0]).not.toContain('pass')
  })
})
