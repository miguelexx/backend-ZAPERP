const request = require('supertest')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'helpdesk-test-secret'
const app = require('../app')

function token(payload = {}) {
  return jwt.sign(
    { id: 7, company_id: 23, perfil: 'admin', ...payload },
    process.env.JWT_SECRET
  )
}

function query(result) {
  const chain = {}
  for (const method of ['select', 'eq', 'order', 'range', 'insert', 'update', 'ilike', 'or', 'gte', 'lte']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('HelpDesk API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('protege as rotas sem token', async () => {
    const response = await request(app).get('/api/helpdesk/tickets')
    expect(response.status).toBe(401)
  })

  it('lista chamados sempre dentro do tenant do token', async () => {
    const listQuery = query({
      data: [{ id: 1, company_id: 23, titulo: 'Impressora' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ total: 1, page: 1, limit: 25 })
    expect(listQuery.eq).toHaveBeenCalledWith('company_id', 23)
  })

  it('cria chamado usando company_id e usuário exclusivamente do token', async () => {
    const insertQuery = query({
      data: { id: 91, company_id: 23, criado_por: 7, titulo: 'Acesso bloqueado' },
      error: null,
    })
    supabase.from.mockReturnValueOnce(insertQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        titulo: 'Acesso bloqueado',
        descricao: 'Não consigo entrar',
        empresa_nome: 'Cliente Teste Ltda',
        cnpj: '12.345.678/0001-90',
        solicitante_nome: 'Maria Cliente',
        company_id: 999,
        criado_por: 999,
      })

    expect(response.status).toBe(201)
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      company_id: 23,
      criado_por: 7,
      titulo: 'Acesso bloqueado',
      empresa_nome: 'Cliente Teste Ltda',
      cnpj: '12.345.678/0001-90',
      solicitante_nome: 'Maria Cliente',
      status: 'aberto',
    }))
  })

  it('não aceita departamento pertencente a outro tenant', async () => {
    const departmentQuery = query({ data: null, error: null })
    supabase.from.mockReturnValueOnce(departmentQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        titulo: 'Rede',
        descricao: 'Sem conexão',
        empresa_nome: 'Cliente Teste Ltda',
        cnpj: '12.345.678/0001-90',
        solicitante_nome: 'Maria Cliente',
        departamento_id: 44,
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('departamento_id inválido')
    expect(departmentQuery.eq).toHaveBeenCalledWith('company_id', 23)
  })

  it('restringe transferência a supervisor ou administrador', async () => {
    const response = await request(app)
      .post('/api/helpdesk/tickets/10/transfer')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ responsavel_id: 8 })

    expect(response.status).toBe(403)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('atualiza status, prioridade e departamento dentro do tenant', async () => {
    const ticketQuery = query({ data: { id: 10, company_id: 23 }, error: null })
    const departmentQuery = query({ data: { id: 44 }, error: null })
    const updateQuery = query({
      data: { id: 10, company_id: 23, status: 'em_atendimento', prioridade: 'urgente', departamento_id: 44 },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(departmentQuery)
      .mockReturnValueOnce(updateQuery)

    const response = await request(app)
      .patch('/api/helpdesk/tickets/10')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'em_atendimento', prioridade: 'urgente', departamento_id: 44 })

    expect(response.status).toBe(200)
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'em_atendimento',
      prioridade: 'urgente',
      departamento_id: 44,
      atualizado_por: 7,
    }))
    expect(updateQuery.eq).toHaveBeenCalledWith('company_id', 23)
  })
})
