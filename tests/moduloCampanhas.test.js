const request = require('supertest')
const jwt = require('jsonwebtoken')
const {
  senhaModuloCampanhasValida,
  getModuloCampanhasSenha,
  SENHA_PADRAO,
  invalidateModuloCampanhasCache,
} = require('../helpers/moduloCampanhas')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
const app = require('../app')
const supabase = require('../config/supabase')
const moduloCampanhas = require('../helpers/moduloCampanhas')

function token(payload = {}) {
  return jwt.sign({ id: 1, company_id: 10, perfil: 'admin', ...payload }, process.env.JWT_SECRET)
}

describe('senha do módulo Campanhas', () => {
  const prev = process.env.MODULO_CAMPANHAS_SENHA

  afterEach(() => {
    if (prev == null) delete process.env.MODULO_CAMPANHAS_SENHA
    else process.env.MODULO_CAMPANHAS_SENHA = prev
  })

  it('aceita a senha padrão quando a env não está definida', () => {
    delete process.env.MODULO_CAMPANHAS_SENHA
    expect(getModuloCampanhasSenha()).toBe(SENHA_PADRAO)
    expect(senhaModuloCampanhasValida(SENHA_PADRAO)).toBe(true)
    expect(senhaModuloCampanhasValida('errada')).toBe(false)
    expect(senhaModuloCampanhasValida('')).toBe(false)
    expect(senhaModuloCampanhasValida(null)).toBe(false)
  })

  it('usa MODULO_CAMPANHAS_SENHA quando definida', () => {
    process.env.MODULO_CAMPANHAS_SENHA = 'Outra@Senha1'
    expect(senhaModuloCampanhasValida('Outra@Senha1')).toBe(true)
    expect(senhaModuloCampanhasValida(SENHA_PADRAO)).toBe(false)
  })
})

describe('PUT /config/empresa — módulo Campanhas', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('não ativa sem senha', async () => {
    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)
      .send({ modulo_campanhas_ativo: true })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/senha/i)
  })

  it('não ativa com senha errada', async () => {
    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)
      .send({ modulo_campanhas_ativo: true, senha_modulo_campanhas: 'senha-errada' })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/inválida/i)
  })

  it('bloqueia supervisor ao ativar', async () => {
    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
      .send({ modulo_campanhas_ativo: true, senha_modulo_campanhas: SENHA_PADRAO })

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/administrador/i)
  })

  it('ativa com a senha correta (admin)', async () => {
    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)
      .send({ modulo_campanhas_ativo: true, senha_modulo_campanhas: SENHA_PADRAO })

    expect(res.status).toBe(200)
  })

  it('desliga sem senha quando já estava ativo', async () => {
    supabase.from.mockImplementationOnce(() => {
      const chain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { modulo_campanhas_ativo: true }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 10, modulo_campanhas_ativo: false }, error: null }),
      }
      chain.update = jest.fn(() => chain)
      return chain
    })

    const res = await request(app)
      .put('/config/empresa')
      .set('Authorization', `Bearer ${token()}`)
      .send({ modulo_campanhas_ativo: false })

    expect(res.status).toBe(200)
  })
})

describe('GET /disparo/campanhas — gate do módulo', () => {
  afterEach(() => {
    moduloCampanhas.empresaModuloCampanhasAtivo.mockResolvedValue(true)
  })

  it('bloqueia admin quando o módulo está desativado', async () => {
    moduloCampanhas.empresaModuloCampanhasAtivo.mockResolvedValue(false)
    const res = await request(app)
      .get('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MODULO_CAMPANHAS_OFF')
  })
})

describe('empresaModuloCampanhasAtivo', () => {
  beforeEach(() => {
    if (jest.isMockFunction(moduloCampanhas.empresaModuloCampanhasAtivo)) {
      moduloCampanhas.empresaModuloCampanhasAtivo.mockRestore()
    }
    invalidateModuloCampanhasCache()
  })

  it('retorna false quando a coluna não existe', async () => {
    supabase.from.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'column modulo_campanhas_ativo does not exist' },
      }),
    })
    await expect(moduloCampanhas.empresaModuloCampanhasAtivo(10)).resolves.toBe(false)
  })

  it('respeita company_id e não cruza empresas', async () => {
    supabase.from.mockImplementation((table) => {
      expect(table).toBe('empresas')
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((col, val) => {
          expect(col).toBe('id')
          expect(val).toBe(7)
          return {
            maybeSingle: jest.fn().mockResolvedValue({
              data: { modulo_campanhas_ativo: true },
              error: null,
            }),
          }
        }),
      }
    })
    await expect(moduloCampanhas.empresaModuloCampanhasAtivo(7)).resolves.toBe(true)
  })
})
