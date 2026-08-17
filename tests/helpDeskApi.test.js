const request = require('supertest')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')
const helpDeskNotificationService = require('../services/helpDeskNotificationService')

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
    jest.spyOn(helpDeskNotificationService, 'settleTicketCreated').mockResolvedValue([])
    jest.spyOn(helpDeskNotificationService, 'settlePreviousAssignee').mockResolvedValue([])
    jest.spyOn(helpDeskNotificationService, 'settleAllTicketNotifications').mockResolvedValue([])
    jest.spyOn(helpDeskNotificationService, 'notifyQueueChanged').mockResolvedValue([])
  })

  afterEach(() => {
    jest.restoreAllMocks()
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
    expect(listQuery.order).toHaveBeenNthCalledWith(1, 'atualizado_em', { ascending: false })
    expect(listQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
  })

  it('ordena chamados somente pelos campos permitidos', async () => {
    const listQuery = query({ data: [], error: null, count: 0 })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets?ordenar_por=empresa&ordem=asc')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(listQuery.order).toHaveBeenNthCalledWith(1, 'empresa_nome', { ascending: true })
    expect(listQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
  })

  it('soma notificações individuais com a fila aberta dos departamentos do usuário', async () => {
    const itemsQuery = query({
      data: [{ id: 80, company_id: 23, usuario_id: 7, ticket_id: 10, lida: false }],
      error: null,
    })
    const countQuery = query({ data: null, error: null, count: 1 })
    const departmentsQuery = query({ data: [{ nome: 'Suporte' }], error: null })
    const queueCountQuery = query({ data: null, error: null, count: 3 })
    supabase.from
      .mockReturnValueOnce(itemsQuery)
      .mockReturnValueOnce(countQuery)
      .mockReturnValueOnce(departmentsQuery)
      .mockReturnValueOnce(queueCountQuery)

    const response = await request(app)
      .get('/api/helpdesk/notifications')
      .set('Authorization', `Bearer ${token({ departamento_id: 44, departamento_ids: [44] })}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ personal_unread_count: 1, queue_count: 3, unread_count: 4 })
    expect(response.body.items).toHaveLength(1)
    expect(itemsQuery.eq).toHaveBeenCalledWith('company_id', 23)
    expect(itemsQuery.eq).toHaveBeenCalledWith('usuario_id', 7)
    expect(countQuery.eq).toHaveBeenCalledWith('lida', false)
    expect(queueCountQuery.eq).toHaveBeenCalledWith('status', 'aberto')
    expect(queueCountQuery.is).toHaveBeenCalledWith('responsavel_id', null)
    expect(queueCountQuery.in).toHaveBeenCalledWith('departamento', ['Suporte'])
  })

  it('marca como lidas somente as notificações do chamado e usuário autenticado', async () => {
    const updateQuery = query({ data: [{ id: 80 }, { id: 81 }], error: null })
    supabase.from.mockReturnValueOnce(updateQuery)

    const response = await request(app)
      .post('/api/helpdesk/notifications/tickets/10/read')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, updated: 2 })
    expect(updateQuery.eq).toHaveBeenCalledWith('company_id', 23)
    expect(updateQuery.eq).toHaveBeenCalledWith('usuario_id', 7)
    expect(updateQuery.eq).toHaveBeenCalledWith('ticket_id', 10)
    expect(updateQuery.eq).toHaveBeenCalledWith('lida', false)
  })

  it('envia chamado novo somente ao departamento sem persistir notificações por usuário', async () => {
    const usersQuery = query({
      data: [
        { id: 7, departamento_id: 5 },
        { id: 9, departamento_id: null },
        { id: 11, departamento_id: 6 },
      ],
      error: null,
    })
    const membershipsQuery = query({ data: [{ usuario_id: 9 }], error: null })
    supabase.from
      .mockReturnValueOnce(usersQuery)
      .mockReturnValueOnce(membershipsQuery)
    const emit = jest.fn()
    const to = jest.fn(() => ({ emit }))
    const req = { app: { get: jest.fn(() => ({ to })) } }

    const result = await helpDeskNotificationService.notifyTicketCreated(req, {
      id: 10,
      company_id: 23,
      departamento: 'Suporte',
      empresa_nome: 'Cliente Teste',
      titulo: 'Erro ao emitir nota',
    }, 5)

    expect(result).toHaveLength(2)
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ usuario_id: 7, ticket_id: 10, tipo: 'ticket_created', efemera: true }),
      expect.objectContaining({ usuario_id: 9, ticket_id: 10, tipo: 'ticket_created', efemera: true }),
    ]))
    expect(to).toHaveBeenCalledWith('usuario_7')
    expect(to).toHaveBeenCalledWith('usuario_9')
    expect(to).not.toHaveBeenCalledWith('usuario_11')
    expect(emit).toHaveBeenCalledWith('helpdesk:notification', expect.any(Object))
    expect(emit).toHaveBeenCalledWith('helpdesk:queue_changed', expect.any(Object))
  })

  it('encerra notificações pendentes e sincroniza o contador de cada usuário', async () => {
    const updateQuery = query({
      data: [
        { id: 90, usuario_id: 7, ticket_id: 10 },
        { id: 91, usuario_id: 9, ticket_id: 10 },
      ],
      error: null,
    })
    supabase.from.mockReturnValueOnce(updateQuery)
    const emit = jest.fn()
    const to = jest.fn(() => ({ emit }))
    const req = { app: { get: jest.fn(() => ({ to })) } }

    const result = await helpDeskNotificationService.markTicketNotificationsRead(req, {
      companyId: 23,
      ticketId: 10,
      types: ['ticket_created'],
      reason: 'ticket_assumed',
    })

    expect(result).toHaveLength(2)
    expect(updateQuery.eq).toHaveBeenCalledWith('company_id', 23)
    expect(updateQuery.eq).toHaveBeenCalledWith('ticket_id', 10)
    expect(updateQuery.eq).toHaveBeenCalledWith('lida', false)
    expect(updateQuery.in).toHaveBeenCalledWith('tipo', ['ticket_created'])
    expect(to).toHaveBeenCalledWith('usuario_7')
    expect(to).toHaveBeenCalledWith('usuario_9')
    expect(emit).toHaveBeenCalledWith('helpdesk:notifications_changed', expect.objectContaining({
      ticket_id: 10,
      updated: 1,
      reason: 'ticket_assumed',
    }))
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
        empresa_razao: 'Cliente Teste Comércio e Serviços Ltda',
        cnpj: '12.345.678/0001-90',
        solicitante_nome: 'Maria Cliente',
        departamento: 'Suporte',
        sistema_operacional: 'Windows 11 Pro',
        nome_maquina: 'FINANCEIRO-01',
        versao_sistema: 'Icthus 4.12.3',
        memoria_ram_bytes: 17179869184,
        processador_nome: 'Intel Core i5-12400',
        processadores_logicos: 12,
        tempo_atividade_segundos: 289200,
        espaco_disponivel_disco_c_bytes: 256000000000,
        espaco_total_disco_c_bytes: 512000000000,
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
      empresa_razao: 'Cliente Teste Comércio e Serviços Ltda',
      memoria_ram_bytes: 17179869184,
      processador_nome: 'Intel Core i5-12400',
      processadores_logicos: 12,
      tempo_atividade_segundos: 289200,
      espaco_disponivel_disco_c_bytes: 256000000000,
      espaco_total_disco_c_bytes: 512000000000,
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

  it('rejeita informações numéricas inválidas do ambiente', async () => {
    const response = await request(app)
      .post('/api/helpdesk/tickets')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12345678000190')
      .send({
        titulo: 'Disco cheio',
        descricao: 'Teste de validação do ambiente.',
        empresa_nome: 'Cliente Teste Ltda',
        solicitante_nome: 'Maria Cliente',
        departamento: 'Suporte',
        espaco_disponivel_disco_c_bytes: 600,
        espaco_total_disco_c_bytes: 500,
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('não pode ser maior')
    expect(supabase.from).not.toHaveBeenCalled()
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
        avaliacao: 4,
        responsavel: { nome: 'Felipe Suporte' },
      },
      error: null,
    })
    const messagesQuery = query({
      data: [{ id: 40, ticket_id: 10, autor_usuario_id: null, solicitante_nome: 'Bruno Lima', interna: false, mensagem: 'Mensagem pública' }],
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
      expect.objectContaining({
        solicitante_nome: 'Bruno Lima',
        autor_nome: 'Bruno Lima',
        interna: false,
        mensagem: 'Mensagem pública',
      }),
    ])
    expect(response.body.avaliacao).toBe(4)
    expect(response.body.transferencias[0]).toMatchObject({
      transferido_por_nome: 'Felipe Suporte',
      de_departamento_nome: 'Financeiro',
      para_departamento_nome: 'Suporte',
      para_responsavel_nome: 'Felipe Suporte',
    })
  })

  it('registra o nome do usuário do Icthus em cada mensagem', async () => {
    const ticketQuery = query({
      data: { id: 10, company_id: 1, cnpj: '12.345.678/0001-90' },
      error: null,
    })
    const insertQuery = query({
      data: {
        id: 41,
        company_id: 1,
        ticket_id: 10,
        autor_usuario_id: null,
        solicitante_nome: 'Bruno Lima',
        mensagem: 'O erro também ocorre comigo.',
        interna: false,
      },
      error: null,
    })
    const ticketUpdateQuery = query({ data: null, error: null })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(insertQuery)
      .mockReturnValueOnce(ticketUpdateQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets/10/messages')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')
      .send({
        mensagem: 'O erro também ocorre comigo.',
        solicitante_nome: 'Bruno Lima',
        interna: true,
      })

    expect(response.status).toBe(201)
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      autor_usuario_id: null,
      solicitante_nome: 'Bruno Lima',
      interna: false,
    }))
    expect(response.body).toMatchObject({
      solicitante_nome: 'Bruno Lima',
      autor_nome: 'Bruno Lima',
      interna: false,
    })
  })

  it('exige solicitante_nome nas mensagens enviadas pelo Icthus', async () => {
    const response = await request(app)
      .post('/api/helpdesk/tickets/10/messages')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')
      .send({ mensagem: 'Mensagem sem identificação.' })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('solicitante_nome é obrigatório')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('assume automaticamente o chamado quando o atendente envia a primeira mensagem', async () => {
    const ticketQuery = query({
      data: { id: 10, company_id: 23, status: 'aberto', departamento: 'Financeiro', responsavel_id: null },
      error: null,
    })
    const departmentQuery = query({ data: { id: 44, nome: 'Suporte' }, error: null })
    const assumeQuery = query({
      data: { id: 10, company_id: 23, status: 'em_atendimento', departamento: 'Suporte', responsavel_id: 7 },
      error: null,
    })
    const previousDepartmentQuery = query({ data: { id: 33, nome: 'Financeiro' }, error: null })
    const historyQuery = query({ data: null, error: null })
    const messageQuery = query({
      data: { id: 42, company_id: 23, ticket_id: 10, autor_usuario_id: 7, mensagem: 'Vou verificar.', interna: false },
      error: null,
    })
    const ticketUpdateQuery = query({ data: null, error: null })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(departmentQuery)
      .mockReturnValueOnce(assumeQuery)
      .mockReturnValueOnce(previousDepartmentQuery)
      .mockReturnValueOnce(historyQuery)
      .mockReturnValueOnce(messageQuery)
      .mockReturnValueOnce(ticketUpdateQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets/10/messages')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente', departamento_id: 44, departamento_ids: [44] })}`)
      .send({ mensagem: 'Vou verificar.' })

    expect(response.status).toBe(201)
    expect(assumeQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'em_atendimento',
      departamento: 'Suporte',
      responsavel_id: 7,
    }))
    expect(historyQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      ticket_id: 10,
      para_departamento_id: 44,
      para_responsavel_id: 7,
      motivo: 'Chamado assumido ao responder',
    }))
    expect(helpDeskNotificationService.settleTicketCreated).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10, responsavel_id: 7 }),
      'ticket_assumed'
    )
    expect(messageQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      ticket_id: 10,
      autor_usuario_id: 7,
      mensagem: 'Vou verificar.',
    }))
  })

  it('permite ao Icthus avaliar seu chamado de 1 a 5', async () => {
    const ticketQuery = query({
      data: { id: 10, company_id: 1, cnpj: '12.345.678/0001-90', avaliacao: 0 },
      error: null,
    })
    const updateQuery = query({
      data: { id: 10, avaliacao: 5 },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(updateQuery)

    const response = await request(app)
      .post('/api/helpdesk/tickets/10/avaliacao')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')
      .send({ avaliacao: 5 })

    expect(response.status).toBe(200)
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ avaliacao: 5 }))
    expect(updateQuery.eq).toHaveBeenCalledWith('cnpj', '12.345.678/0001-90')
    expect(response.body).toEqual({ id: 10, avaliacao: 5 })
  })

  it('rejeita avaliação fora do intervalo de 1 a 5', async () => {
    const response = await request(app)
      .post('/api/helpdesk/tickets/10/avaliacao')
      .set('X-HelpDesk-Token', process.env.HELPDESK_INTEGRATION_TOKEN)
      .set('X-Icthus-CNPJ', '12.345.678/0001-90')
      .send({ avaliacao: 0 })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('avaliacao deve ser um número inteiro de 1 a 5')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('localiza CNPJ com máscara quando a busca é enviada sem máscara', async () => {
    const listQuery = query({ data: [], error: null, count: 0 })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets?q=12345678000190')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(listQuery.or).toHaveBeenCalledWith(expect.stringContaining('empresa_razao.ilike'))
    expect(listQuery.or).toHaveBeenCalledWith(expect.stringContaining(
      'cnpj.ilike.%1%2%3%4%5%6%7%8%0%0%0%1%9%0%'
    ))
  })

  it('localiza chamado pelo ID na pesquisa unificada', async () => {
    const listQuery = query({ data: [], error: null, count: 0 })
    supabase.from.mockReturnValueOnce(listQuery)

    const response = await request(app)
      .get('/api/helpdesk/tickets?q=%2310')
      .set('Authorization', `Bearer ${token()}`)

    expect(response.status).toBe(200)
    expect(listQuery.or).toHaveBeenCalledWith(expect.stringContaining('id.eq.10'))
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
    expect(helpDeskNotificationService.settleTicketCreated).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10, responsavel_id: 7 }),
      'ticket_assumed'
    )
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
    expect(helpDeskNotificationService.settleTicketCreated).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10, responsavel_id: 8 }),
      'ticket_transferred'
    )
    expect(helpDeskNotificationService.settlePreviousAssignee).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10 }),
      7,
      'ticket_transferred'
    )
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
    expect(helpDeskNotificationService.settleTicketCreated).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10 }),
      'ticket_in_service'
    )
  })

  it('encerra todas as notificações pendentes quando o chamado é resolvido', async () => {
    const ticketQuery = query({ data: { id: 10, company_id: 23, status: 'em_atendimento' }, error: null })
    const updateQuery = query({
      data: { id: 10, company_id: 23, status: 'resolvido' },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(ticketQuery)
      .mockReturnValueOnce(updateQuery)

    const response = await request(app)
      .patch('/api/helpdesk/tickets/10')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'resolvido' })

    expect(response.status).toBe(200)
    expect(helpDeskNotificationService.settleAllTicketNotifications).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: 10, status: 'resolvido' }),
      'ticket_resolved'
    )
  })
})
