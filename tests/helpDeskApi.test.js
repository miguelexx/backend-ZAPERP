const request = require('supertest')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'helpdesk-test-secret'
process.env.HELPDESK_INTEGRATION_TOKEN = 'icthus-helpdesk-test-token'
process.env.HELPDESK_INTEGRATION_COMPANY_ID = '1'
const app = require('../app')

function token(payload = {}) {
  return jwt.sign(
    { id: 7, company_id: 23, perfil: 'admin', ...payload },
    process.env.JWT_SECRET
  )
}

function query(result) {
  const chain = {}
  for (const method of ['select', 'eq', 'is', 'in', 'limit', 'order', 'range', 'insert', 'update', 'ilike', 'or', 'gte', 'lte']) {
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

  it('cria chamado do Icthus usando empresa e cliente exclusivamente da integração', async () => {
    const departmentQuery = query({ data: { id: 5, nome: 'Suporte' }, error: null })
    const insertQuery = query({
      data: { id: 91, company_id: 1, cnpj: '12.345.678/0001-90', criado_por: null, departamento: 'Suporte', titulo: 'Acesso bloqueado' },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(departmentQuery)
      .mockReturnValueOnce(insertQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12345678000190')
      .send({
        titulo: 'Acesso bloqueado',
        descricao: 'Não consigo entrar',
        empresa_nome: 'Cliente Teste Ltda',
        cnpj: '12.345.678/0001-90',
        solicitante_nome: 'Maria Cliente',
        departamento: 'Suporte',
        sistema_operacional: 'Windows 11 Pro',
        nome_maquina: 'FINANCEIRO-01',
        versao_sistema: 'Icthus 4.12.3',
        company_id: 999,
        criado_por: 999,
      })

    expect(response.status).toBe(201)
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      company_id: 1,
      cnpj: '12.345.678/0001-90',
      criado_por: null,
      sistema_operacional: 'Windows 11 Pro',
      nome_maquina: 'FINANCEIRO-01',
      versao_sistema: 'Icthus 4.12.3',
      titulo: 'Acesso bloqueado',
      empresa_nome: 'Cliente Teste Ltda',
      cnpj: '12.345.678/0001-90',
      solicitante_nome: 'Maria Cliente',
      departamento: 'Suporte',
      status: 'aberto',
    }))
    expect(departmentQuery.eq).toHaveBeenCalledWith('company_id', 1)
    expect(departmentQuery.ilike).toHaveBeenCalledWith('nome', 'Suporte')
  })

  it('rejeita criação com JWT porque chamados nascem no Icthus', async () => {
    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('Authorization', `Bearer ${token()}`)
      .send({ titulo: 'Acesso bloqueado' })

    expect(response.status).toBe(401)
    expect(response.body.error).toBe('Token de integracao nao informado')
  })

  it('restringe a listagem do Icthus ao cliente externo autenticado', async () => {
    const listQuery = query({ data: [], error: null, count: 0 })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')

    expect(response.status).toBe(200)
    expect(listQuery.eq).toHaveBeenCalledWith('company_id', 1)
    expect(listQuery.eq).toHaveBeenCalledWith('cnpj', '12.345.678/0001-90')
  })

  it('não aceita nome de departamento inexistente no tenant da integração', async () => {
    const departmentQuery = query({ data: null, error: null })
    supabase.from.mockReturnValueOnce(departmentQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')
      .send({
        titulo: 'Rede',
        descricao: 'Sem conexão',
        empresa_nome: 'Cliente Teste Ltda',
        cnpj: '12.345.678/0001-90',
        solicitante_nome: 'Maria Cliente',
        departamento: 'Departamento inexistente',
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('departamento inválido')
    expect(departmentQuery.eq).toHaveBeenCalledWith('company_id', 1)
  })

  it('inclui o nome do responsável na listagem de chamados', async () => {
    const listQuery = query({
      data: [{ id: 1, company_id: 23, responsavel_id: 7, responsavel: { nome: 'Felipe Suporte' }, titulo: 'Impressora' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(response.body.items[0]).toMatchObject({
      responsavel_id: 7,
      responsavel_nome: 'Felipe Suporte',
    })
    expect(listQuery.select).toHaveBeenCalledWith(
      expect.stringContaining('responsavel:usuarios!helpdesk_tickets_responsavel_id_fkey(nome)'),
      { count: 'exact' }
    )
  })

  it('retorna responsável atual e nomes do histórico no detalhe do chamado', async () => {
    const ticketQuery = query({
      data: {
        id: 10,
        company_id: 23,
        responsavel_id: 7,
        responsavel: { nome: 'Felipe Suporte' },
      },
      error: null,
    })
    const messagesQuery = query({ data: [], error: null })
    const transfersQuery = query({
      data: [{
        id: 30,
        ticket_id: 10,
        transferido_por: 7,
        transferido_por_usuario: { nome: 'Felipe Suporte' },
        de_responsavel_usuario: { nome: 'Administrador' },
        para_responsavel_usuario: { nome: 'Carlos Financeiro' },
        de_departamento: { nome: 'Suporte' },
        para_departamento: { nome: 'Financeiro' },
      }],
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(messagesQuery)
      .mockReturnValueOnce(transfersQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets/10')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      responsavel_id: 7,
      responsavel_nome: 'Felipe Suporte',
    })
    expect(response.body.transferencias[0]).toMatchObject({
      transferido_por: 7,
      transferido_por_nome: 'Felipe Suporte',
      de_responsavel_nome: 'Administrador',
      para_responsavel_nome: 'Carlos Financeiro',
      de_departamento_nome: 'Suporte',
      para_departamento_nome: 'Financeiro',
    })
    expect(transfersQuery.select).toHaveBeenCalledWith(expect.stringContaining('transferido_por_usuario'))
  })

  it('retorna transferências ao Icthus sem expor notas internas', async () => {
    const ticketQuery = query({
      data: {
        id: 10,
        company_id: 1,
        cnpj: '12.345.678/0001-90',
        responsavel_id: 7,
        responsavel: { nome: 'Felipe Suporte' },
      },
      error: null,
    })
    const messagesQuery = query({
      data: [{ id: 40, ticket_id: 10, interna: false, mensagem: 'Mensagem pública' }],
      error: null,
    })
    const transfersQuery = query({
      data: [{
        id: 30,
        ticket_id: 10,
        transferido_por: 7,
        transferido_por_usuario: { nome: 'Felipe Suporte' },
        de_responsavel_usuario: null,
        para_responsavel_usuario: { nome: 'Felipe Suporte' },
        de_departamento: { nome: 'Financeiro' },
        para_departamento: { nome: 'Suporte' },
      }],
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(messagesQuery)
      .mockReturnValueOnce(transfersQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets/10')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')

    expect(response.status).toBe(200)
    expect(ticketQuery.eq).toHaveBeenCalledWith('cnpj', '12.345.678/0001-90')
    expect(messagesQuery.eq).toHaveBeenCalledWith('interna', false)
    expect(response.body.mensagens).toEqual([
      expect.objectContaining({ interna: false, mensagem: 'Mensagem pública' }),
    ])
    expect(response.body.transferencias[0]).toMatchObject({
      transferido_por_nome: 'Felipe Suporte',
      de_departamento_nome: 'Financeiro',
      para_departamento_nome: 'Suporte',
      para_responsavel_nome: 'Felipe Suporte',
    })
  })

  it('localiza CNPJ com máscara quando a busca é enviada sem máscara', async () => {
    const listQuery = query({ data: [], error: null, count: 0 })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets?q=12345678000190')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(listQuery.or).toHaveBeenCalledWith(expect.stringContaining(
      'cnpj.ilike.%1%2%3%4%5%6%7%8%0%0%0%1%9%0%'
    ))
  })

  it('permite ao atendente assumir chamado aberto no próprio departamento', async () => {
    const departmentQuery = query({ data: { id: 44, nome: 'Suporte' }, error: null })
    const ticketQuery = query({ data: { id: 10, company_id: 23, status: 'aberto', departamento: 'Financeiro', responsavel_id: null }, error: null })
    const updateQuery = query({ data: { id: 10, company_id: 23, status: 'em_atendimento', departamento: 'Suporte', responsavel_id: 7 }, error: null })
    const previousDepartmentQuery = query({ data: { id: 33, nome: 'Financeiro' }, error: null })
    const historyQuery = query({ data: null, error: null })
    supabase.from
      .mockReturnValueOnce(departmentQuery)
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(previousDepartmentQuery)
      .mockReturnValueOnce(historyQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets/10/assume')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente', departamento_id: 44, departamento_ids: [44] })}`)

    expect(response.status).toBe(200)
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'em_atendimento',
      departamento: 'Suporte',
      responsavel_id: 7,
      atualizado_por: 7,
    }))
    expect(historyQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      ticket_id: 10,
      para_departamento_id: 44,
      para_responsavel_id: 7,
      motivo: 'Chamado assumido',
    }))
  })

  it('permite transferência por atendente autenticado', async () => {
    const ticketQuery = query({ data: { id: 10, company_id: 23, departamento: 'Financeiro', responsavel_id: 7 }, error: null })
    const assigneeQuery = query({ data: { id: 8, ativo: true, departamento_id: 44 }, error: null })
    const currentDepartmentQuery = query({ data: { id: 33, nome: 'Financeiro' }, error: null })
    const assigneeDepartmentQuery = query({ data: { id: 44, nome: 'Suporte' }, error: null })
    const updateQuery = query({ data: { id: 10, company_id: 23, departamento: 'Suporte', responsavel_id: 8 }, error: null })
    const historyQuery = query({ data: null, error: null })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(assigneeQuery)
      .mockReturnValueOnce(currentDepartmentQuery)
      .mockReturnValueOnce(assigneeDepartmentQuery)
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(historyQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets/10/transfer')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ responsavel_id: 8 })

    expect(response.status).toBe(200)
  })

  it('atualiza status, prioridade e departamento dentro do tenant', async () => {
    const ticketQuery = query({ data: { id: 10, company_id: 23 }, error: null })
    const departmentQuery = query({ data: { id: 44, nome: 'Suporte' }, error: null })
    const updateQuery = query({
      data: { id: 10, company_id: 23, status: 'em_atendimento', prioridade: 'urgente', departamento: 'Suporte' },
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
      departamento: 'Suporte',
      atualizado_por: 7,
    }))
    expect(updateQuery.eq).toHaveBeenCalledWith('company_id', 23)
  })
})
