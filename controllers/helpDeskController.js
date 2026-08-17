const supabase = require('../config/supabase')
const helpDeskNotifications = require('../services/helpDeskNotificationService')

const PRIORITIES = new Set(['baixa', 'normal', 'alta', 'urgente'])
const STATUSES = new Set(['aberto', 'em_atendimento', 'resolvido'])
const TICKET_ORDER_FIELDS = {
  status: 'status',
  empresa: 'empresa_nome',
  numero: 'id',
  atualizado: 'atualizado_em',
  criado: 'criado_em',
}
const TICKET_DETAIL_SELECT = '*, responsavel:usuarios!helpdesk_tickets_responsavel_id_fkey(nome)'
const MESSAGE_DETAIL_SELECT = '*, autor_usuario:usuarios!helpdesk_mensagens_autor_usuario_id_fkey(nome)'
const TRANSFER_DETAIL_SELECT = [
  '*',
  'transferido_por_usuario:usuarios!helpdesk_transferencias_transferido_por_fkey(nome)',
  'de_responsavel_usuario:usuarios!helpdesk_transferencias_de_responsavel_id_fkey(nome)',
  'para_responsavel_usuario:usuarios!helpdesk_transferencias_para_responsavel_id_fkey(nome)',
  'de_departamento:departamentos!helpdesk_transferencias_de_departamento_id_fkey(nome)',
  'para_departamento:departamentos!helpdesk_transferencias_para_departamento_id_fkey(nome)',
].join(', ')
const TICKET_CHANGED_EVENT = 'helpdesk:ticket_changed'

function positiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function cnpjSearchPattern(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 14)
  return digits ? digits.split('').join('%') : ''
}

function isDepartmentRestrictedUser(user) {
  return String(user?.perfil || '').trim().toLowerCase() === 'atendente'
}

function userDepartmentIds(user) {
  return [...new Set([
    ...(Array.isArray(user?.departamento_ids) ? user.departamento_ids : []),
    user?.departamento_id,
  ].map(positiveInt).filter(Boolean))]
}

async function allowedDepartmentNames(user) {
  if (!isDepartmentRestrictedUser(user)) return null
  const companyId = positiveInt(user?.company_id)
  const departmentIds = userDepartmentIds(user)
  if (!companyId || departmentIds.length === 0) return []
  const { data, error } = await supabase
    .from('departamentos')
    .select('nome')
    .eq('company_id', companyId)
    .in('id', departmentIds)
  if (error) throw error
  return [...new Set((data || []).map((item) => cleanText(item.nome, 120)).filter(Boolean))]
}

async function userCanAccessTicket(user, ticket) {
  const names = await allowedDepartmentNames(user)
  if (names === null) return true
  const ticketDepartment = cleanText(ticket?.departamento, 120).toLocaleLowerCase('pt-BR')
  return Boolean(ticketDepartment) && names.some((name) => name.toLocaleLowerCase('pt-BR') === ticketDepartment)
}

function databaseError(res, error, fallback) {
  console.error('[helpDesk]', fallback, error)
  return res.status(500).json({ error: fallback })
}

async function findTenantEntity(table, id, companyId, select = 'id') {
  if (!id) return null
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function findTenantDepartmentByName(name, companyId) {
  if (!name) return null
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', companyId)
    .ilike('nome', name)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

function flattenResponsible(ticket) {
  if (!ticket) return ticket
  const { responsavel, ...fields } = ticket
  return { ...fields, responsavel_nome: responsavel?.nome || null }
}

function emitTicketChanged(req, companyId, ticketId, action) {
  const io = req.app?.get?.('io')
  if (!io || !companyId || !ticketId) return
  const payload = {
    company_id: Number(companyId),
    ticket_id: Number(ticketId),
    action,
    ocorrido_em: new Date().toISOString(),
  }
  if (typeof io.emitEmpresa === 'function') {
    io.emitEmpresa(companyId, TICKET_CHANGED_EVENT, payload)
    return
  }
  io.to?.(`empresa_${companyId}`)?.emit?.(TICKET_CHANGED_EVENT, payload)
}

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN
}

function flattenMessage(message, fallbackName = null) {
  const { autor_usuario, ...fields } = message
  return {
    ...fields,
    autor_nome: autor_usuario?.nome || fields.solicitante_nome || fallbackName || null,
  }
}

function flattenTransfer(transfer) {
  const {
    transferido_por_usuario,
    de_responsavel_usuario,
    para_responsavel_usuario,
    de_departamento,
    para_departamento,
    ...fields
  } = transfer
  return {
    ...fields,
    transferido_por_nome: transferido_por_usuario?.nome || null,
    de_responsavel_nome: de_responsavel_usuario?.nome || null,
    para_responsavel_nome: para_responsavel_usuario?.nome || null,
    de_departamento_nome: de_departamento?.nome || null,
    para_departamento_nome: para_departamento?.nome || null,
  }
}

async function findTicket(id, companyId, integrationCnpj = null, select = '*') {
  let query = supabase.from('helpdesk_tickets').select(select).eq('id', id).eq('company_id', companyId)
  if (integrationCnpj) query = query.eq('cnpj', integrationCnpj)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data
}

exports.createTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const userId = positiveInt(req.user.id)
    const body = req.body || {}
    const title = cleanText(body.titulo, 180)
    const description = cleanText(body.descricao, 10000)
    const companyName = cleanText(body.empresa_nome, 180)
    const companyLegalName = cleanText(body.empresa_razao, 180) || null
    const cnpj = req.helpDeskIntegration ? req.integrationCnpj : cleanText(body.cnpj, 18)
    const requesterName = cleanText(body.solicitante_nome, 180)
    const phone = cleanText(body.telefone, 30) || null
    const operatingSystem = cleanText(body.sistema_operacional, 120) || null
    const machineName = cleanText(body.nome_maquina, 120) || null
    const systemVersion = cleanText(body.versao_sistema, 120) || null
    const memoryBytes = optionalNonNegativeInteger(body.memoria_ram_bytes)
    const processorName = cleanText(body.processador_nome, 180) || null
    const logicalProcessors = optionalNonNegativeInteger(body.processadores_logicos)
    const uptimeSeconds = optionalNonNegativeInteger(body.tempo_atividade_segundos)
    const availableDiskBytes = optionalNonNegativeInteger(body.espaco_disponivel_disco_c_bytes)
    const totalDiskBytes = optionalNonNegativeInteger(body.espaco_total_disco_c_bytes)
    const priority = body.prioridade == null ? 'normal' : String(body.prioridade).toLowerCase()
    const departmentName = cleanText(body.departamento, 120)
    const assigneeId = positiveInt(body.responsavel_id)
    const clientId = positiveInt(body.cliente_id)

    if (!title) return res.status(400).json({ error: 'titulo é obrigatório' })
    if (!description) return res.status(400).json({ error: 'descricao é obrigatória' })
    if (!companyName) return res.status(400).json({ error: 'empresa_nome é obrigatório' })
    if (!cnpj) return res.status(400).json({ error: 'cnpj é obrigatório' })
    if (!requesterName) return res.status(400).json({ error: 'solicitante_nome é obrigatório' })
    if (!departmentName) return res.status(400).json({ error: 'departamento é obrigatório' })
    if (!PRIORITIES.has(priority)) return res.status(400).json({ error: 'prioridade inválida' })
    const invalidNumericField = [
      ['memoria_ram_bytes', memoryBytes],
      ['processadores_logicos', logicalProcessors],
      ['tempo_atividade_segundos', uptimeSeconds],
      ['espaco_disponivel_disco_c_bytes', availableDiskBytes],
      ['espaco_total_disco_c_bytes', totalDiskBytes],
    ].find(([, value]) => Number.isNaN(value))
    if (invalidNumericField) {
      return res.status(400).json({ error: `${invalidNumericField[0]} deve ser um número inteiro não negativo` })
    }
    if (logicalProcessors === 0) {
      return res.status(400).json({ error: 'processadores_logicos deve ser maior que zero' })
    }
    if (availableDiskBytes !== null && totalDiskBytes !== null && availableDiskBytes > totalDiskBytes) {
      return res.status(400).json({ error: 'espaco_disponivel_disco_c_bytes não pode ser maior que espaco_total_disco_c_bytes' })
    }

    const department = await findTenantDepartmentByName(departmentName, companyId)
    if (!department) return res.status(400).json({ error: 'departamento inválido' })
    if (clientId && !(await findTenantEntity('clientes', clientId, companyId))) {
      return res.status(400).json({ error: 'cliente_id inválido' })
    }
    if (assigneeId) {
      const assignee = await findTenantEntity('usuarios', assigneeId, companyId, 'id, ativo')
      if (!assignee || assignee.ativo === false) return res.status(400).json({ error: 'responsavel_id inválido' })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .insert({
        company_id: companyId,
        titulo: title,
        descricao: description,
        empresa_nome: companyName,
        empresa_razao: companyLegalName,
        cnpj,
        solicitante_nome: requesterName,
        telefone: phone,
        sistema_operacional: operatingSystem,
        nome_maquina: machineName,
        versao_sistema: systemVersion,
        memoria_ram_bytes: memoryBytes,
        processador_nome: processorName,
        processadores_logicos: logicalProcessors,
        tempo_atividade_segundos: uptimeSeconds,
        espaco_disponivel_disco_c_bytes: availableDiskBytes,
        espaco_total_disco_c_bytes: totalDiskBytes,
        prioridade: priority,
        status: 'aberto',
        cliente_id: clientId,
        departamento: department.nome,
        responsavel_id: assigneeId,
        criado_por: userId,
        atualizado_por: userId,
        atribuido_em: assigneeId ? now : null,
      })
      .select('*')
      .single()

    if (error) return databaseError(res, error, 'Erro ao criar chamado')
    emitTicketChanged(req, companyId, data.id, 'ticket_created')
    await helpDeskNotifications.notifyTicketCreated(req, data, department.id)
    return res.status(201).json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao criar chamado')
  }
}

exports.listTickets = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const page = Math.max(1, positiveInt(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, positiveInt(req.query.limit) || 25))
    const from = (page - 1) * limit
    const status = req.query.status ? String(req.query.status).toLowerCase() : null
    const priority = req.query.prioridade ? String(req.query.prioridade).toLowerCase() : null
    const search = cleanText(req.query.q, 180)
    const clientName = cleanText(req.query.cliente || req.query.empresa_nome, 180)
    const cnpj = cleanText(req.query.cnpj, 18)
    const startDate = cleanText(req.query.data_inicio, 40)
    const endDate = cleanText(req.query.data_fim, 40)
    const requestedOrder = cleanText(req.query.ordenar_por, 30).toLowerCase()
    const orderField = TICKET_ORDER_FIELDS[requestedOrder] || TICKET_ORDER_FIELDS.atualizado
    const orderDirection = cleanText(req.query.ordem, 4).toLowerCase()
    const ascending = orderDirection === 'asc'

    if (status && !STATUSES.has(status)) return res.status(400).json({ error: 'status inválido' })
    if (priority && !PRIORITIES.has(priority)) return res.status(400).json({ error: 'prioridade inválida' })

    const restrictedDepartments = req.helpDeskIntegration ? null : await allowedDepartmentNames(req.user)
    if (Array.isArray(restrictedDepartments) && restrictedDepartments.length === 0) {
      return res.json({ items: [], page, limit, total: 0 })
    }

    let query = supabase
      .from('helpdesk_tickets')
      .select('*, responsavel:usuarios!helpdesk_tickets_responsavel_id_fkey(nome)', { count: 'exact' })
      .eq('company_id', companyId)

    query = query.order(orderField, { ascending })
    if (orderField !== 'id') query = query.order('id', { ascending: false })
    query = query.range(from, from + limit - 1)

    if (req.helpDeskIntegration) query = query.eq('cnpj', req.integrationCnpj)
    if (Array.isArray(restrictedDepartments)) query = query.in('departamento', restrictedDepartments)

    if (status) query = query.eq('status', status)
    if (priority) query = query.eq('prioridade', priority)
    if (cleanText(req.query.departamento, 120)) query = query.ilike('departamento', cleanText(req.query.departamento, 120))
    if (positiveInt(req.query.responsavel_id)) query = query.eq('responsavel_id', positiveInt(req.query.responsavel_id))
    if (search) {
      const safeSearch = search.replace(/[,%()]/g, ' ')
      const filters = [
        `empresa_nome.ilike.%${safeSearch}%`,
        `empresa_razao.ilike.%${safeSearch}%`,
        `cnpj.ilike.%${safeSearch}%`,
      ]
      const searchedTicketId = positiveInt(search.replace(/^#\s*/, ''))
      if (searchedTicketId) filters.push(`id.eq.${searchedTicketId}`)
      if (/^[\d\s./-]+$/.test(search)) {
        const digitPattern = cnpjSearchPattern(search)
        if (digitPattern) filters.push(`cnpj.ilike.%${digitPattern}%`)
      }
      query = query.or(filters.join(','))
    }
    if (clientName) query = query.ilike('empresa_nome', `%${clientName}%`)
    if (cnpj) query = query.ilike('cnpj', `%${cnpjSearchPattern(cnpj) || cnpj}%`)
    if (startDate) {
      const parsed = new Date(`${startDate}T00:00:00.000`)
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'data_inicio inválida' })
      query = query.gte('criado_em', parsed.toISOString())
    }
    if (endDate) {
      const parsed = new Date(`${endDate}T23:59:59.999`)
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'data_fim inválida' })
      query = query.lte('criado_em', parsed.toISOString())
    }

    const { data, error, count } = await query
    if (error) return databaseError(res, error, 'Erro ao listar chamados')
    const items = (data || []).map(flattenResponsible)
    return res.json({ items, page, limit, total: count || 0 })
  } catch (error) {
    return databaseError(res, error, 'Erro ao listar chamados')
  }
}

exports.getTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const ticketId = positiveInt(req.params.id)
    if (!ticketId) return res.status(400).json({ error: 'id inválido' })

    const ticket = await findTicket(
      ticketId,
      companyId,
      req.helpDeskIntegration ? req.integrationCnpj : null,
      TICKET_DETAIL_SELECT
    )
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' })
    if (!req.helpDeskIntegration && !(await userCanAccessTicket(req.user, ticket))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    let messagesQuery = supabase.from('helpdesk_mensagens').select(MESSAGE_DETAIL_SELECT).eq('ticket_id', ticketId).eq('company_id', companyId)
    if (req.helpDeskIntegration) messagesQuery = messagesQuery.eq('interna', false)
    const [messagesResult, transfersResult] = await Promise.all([
      messagesQuery.order('criado_em', { ascending: true }),
      supabase.from('helpdesk_transferencias').select(TRANSFER_DETAIL_SELECT).eq('ticket_id', ticketId).eq('company_id', companyId).order('criado_em', { ascending: true }),
    ])
    if (messagesResult.error) throw messagesResult.error
    if (transfersResult.error) throw transfersResult.error

    return res.json({
      ...flattenResponsible(ticket),
      mensagens: (messagesResult.data || []).map((message) => flattenMessage(
        message,
        message.autor_usuario_id ? null : ticket.solicitante_nome
      )),
      transferencias: (transfersResult.data || []).map(flattenTransfer),
    })
  } catch (error) {
    return databaseError(res, error, 'Erro ao obter chamado')
  }
}

exports.updateTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const userId = positiveInt(req.user.id)
    const ticketId = positiveInt(req.params.id)
    const body = req.body || {}

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    const existingTicket = await findTicket(ticketId, companyId)
    if (!existingTicket) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }
    if (!(await userCanAccessTicket(req.user, existingTicket))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    const patch = { atualizado_em: new Date().toISOString(), atualizado_por: userId }
    let changed = false
    let queueChanged = false

    if (body.status !== undefined) {
      const status = String(body.status).toLowerCase()
      if (!STATUSES.has(status)) return res.status(400).json({ error: 'status inválido' })
      patch.status = status
      changed = true
      queueChanged = true
    }

    if (body.prioridade !== undefined) {
      const priority = String(body.prioridade).toLowerCase()
      if (!PRIORITIES.has(priority)) return res.status(400).json({ error: 'prioridade inválida' })
      patch.prioridade = priority
      changed = true
    }

    if (body.departamento !== undefined || body.departamento_id !== undefined) {
      let department = null
      if (body.departamento !== undefined) {
        const departmentName = cleanText(body.departamento, 120)
        if (departmentName) department = await findTenantDepartmentByName(departmentName, companyId)
      } else {
        const departmentId = positiveInt(body.departamento_id)
        if (departmentId) department = await findTenantEntity('departamentos', departmentId, companyId, 'id, nome')
      }
      if (!department) return res.status(400).json({ error: 'departamento inválido' })
      patch.departamento = department.nome
      changed = true
      queueChanged = true
    }

    if (!changed) {
      return res.status(400).json({ error: 'Informe status, prioridade ou departamento' })
    }

    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .update(patch)
      .eq('id', ticketId)
      .eq('company_id', companyId)
      .select('*')
      .maybeSingle()

    if (error) return databaseError(res, error, 'Erro ao atualizar chamado')
    if (!data) return res.status(409).json({ error: 'Chamado foi alterado por outro usuário' })
    if (patch.status === 'resolvido') {
      await helpDeskNotifications.settleAllTicketNotifications(req, data, 'ticket_resolved')
    } else if (patch.status === 'em_atendimento') {
      await helpDeskNotifications.settleTicketCreated(req, data, 'ticket_in_service')
    }
    if (queueChanged) {
      await helpDeskNotifications.notifyQueueChanged(
        req,
        data,
        [existingTicket.departamento, data.departamento],
        patch.status === 'resolvido' ? 'ticket_resolved' : 'ticket_updated'
      )
    }
    emitTicketChanged(req, companyId, ticketId, 'ticket_updated')
    return res.json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao atualizar chamado')
  }
}

exports.addMessage = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const userId = positiveInt(req.user.id)
    const ticketId = positiveInt(req.params.id)
    const message = cleanText(req.body?.mensagem, 10000)
    const requesterName = cleanText(req.body?.solicitante_nome, 180)
    const internal = req.helpDeskIntegration ? false : req.body?.interna === true

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    if (!message) return res.status(400).json({ error: 'mensagem é obrigatória' })
    if (req.helpDeskIntegration && !requesterName) {
      return res.status(400).json({ error: 'solicitante_nome é obrigatório' })
    }
    const ticket = await findTicket(ticketId, companyId, req.helpDeskIntegration ? req.integrationCnpj : null)
    if (!ticket) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }
    if (!req.helpDeskIntegration && !(await userCanAccessTicket(req.user, ticket))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    if (!req.helpDeskIntegration && !ticket.responsavel_id && ticket.status !== 'resolvido') {
      const departmentIds = Array.isArray(req.user.departamento_ids)
        ? req.user.departamento_ids.map(positiveInt).filter(Boolean)
        : []
      const departmentId = positiveInt(req.user.departamento_id) || departmentIds[0] || null
      if (!departmentId) return res.status(400).json({ error: 'Usuário sem departamento vinculado' })

      const department = await findTenantEntity('departamentos', departmentId, companyId, 'id, nome')
      if (!department) return res.status(400).json({ error: 'Departamento do usuário inválido' })

      const now = new Date().toISOString()
      const { data: assumedTicket, error: assumeError } = await supabase
        .from('helpdesk_tickets')
        .update({
          status: 'em_atendimento',
          departamento: department.nome,
          responsavel_id: userId,
          atribuido_em: now,
          atualizado_em: now,
          atualizado_por: userId,
        })
        .eq('id', ticketId)
        .eq('company_id', companyId)
        .is('responsavel_id', null)
        .select('*')
        .maybeSingle()
      if (assumeError) return databaseError(res, assumeError, 'Erro ao assumir chamado antes de responder')

      if (assumedTicket) {
        const previousDepartment = await findTenantDepartmentByName(ticket.departamento, companyId)
        const transferResult = await supabase.from('helpdesk_transferencias').insert({
          company_id: companyId,
          ticket_id: ticketId,
          de_departamento_id: previousDepartment?.id || null,
          para_departamento_id: departmentId,
          de_responsavel_id: ticket.responsavel_id,
          para_responsavel_id: userId,
          transferido_por: userId,
          motivo: 'Chamado assumido ao responder',
        })
        if (transferResult.error) {
          return databaseError(res, transferResult.error, 'Chamado assumido, mas o histórico não pôde ser registrado')
        }
        await helpDeskNotifications.settleTicketCreated(req, assumedTicket, 'ticket_assumed')
        await helpDeskNotifications.notifyQueueChanged(
          req,
          assumedTicket,
          [ticket.departamento, assumedTicket.departamento],
          'ticket_assumed'
        )
      }
    }

    const { data, error } = await supabase
      .from('helpdesk_mensagens')
      .insert({
        company_id: companyId,
        ticket_id: ticketId,
        autor_usuario_id: userId,
        solicitante_nome: req.helpDeskIntegration ? requesterName : null,
        mensagem: message,
        interna: internal,
      })
      .select('*')
      .single()
    if (error) return databaseError(res, error, 'Erro ao adicionar mensagem')

    await supabase
      .from('helpdesk_tickets')
      .update({ atualizado_em: new Date().toISOString(), atualizado_por: userId })
      .eq('id', ticketId)
      .eq('company_id', companyId)

    emitTicketChanged(req, companyId, ticketId, 'message_created')
    if (req.helpDeskIntegration) {
      await helpDeskNotifications.notifyExternalMessage(req, ticket, requesterName)
    }
    return res.status(201).json(flattenMessage(data, requesterName || cleanText(req.user?.nome, 180)))
  } catch (error) {
    return databaseError(res, error, 'Erro ao adicionar mensagem')
  }
}

exports.rateTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const ticketId = positiveInt(req.params.id)
    const rating = Number(req.body?.avaliacao)

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'avaliacao deve ser um número inteiro de 1 a 5' })
    }
    if (!(await findTicket(ticketId, companyId, req.integrationCnpj))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .update({ avaliacao: rating, atualizado_em: new Date().toISOString() })
      .eq('id', ticketId)
      .eq('company_id', companyId)
      .eq('cnpj', req.integrationCnpj)
      .select('id, avaliacao')
      .maybeSingle()

    if (error) return databaseError(res, error, 'Erro ao avaliar chamado')
    if (!data) return res.status(404).json({ error: 'Chamado não encontrado' })
    emitTicketChanged(req, companyId, ticketId, 'ticket_rated')
    return res.json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao avaliar chamado')
  }
}

exports.assumeTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const userId = positiveInt(req.user.id)
    const ticketId = positiveInt(req.params.id)
    const departmentIds = Array.isArray(req.user.departamento_ids)
      ? req.user.departamento_ids.map(positiveInt).filter(Boolean)
      : []
    const departmentId = positiveInt(req.user.departamento_id) || departmentIds[0] || null

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    if (!userId) return res.status(401).json({ error: 'Usuário inválido' })
    if (!departmentId) return res.status(400).json({ error: 'Usuário sem departamento vinculado' })

    const department = await findTenantEntity('departamentos', departmentId, companyId, 'id, nome')
    if (!department) return res.status(400).json({ error: 'Departamento do usuário inválido' })

    const ticket = await findTicket(ticketId, companyId)
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' })
    if (!(await userCanAccessTicket(req.user, ticket))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }
    if (ticket.status === 'resolvido') return res.status(409).json({ error: 'Chamado resolvido não pode ser assumido' })
    if (ticket.responsavel_id) return res.status(409).json({ error: 'Chamado já possui responsável' })

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .update({
        status: 'em_atendimento',
        departamento: department.nome,
        responsavel_id: userId,
        atribuido_em: now,
        atualizado_em: now,
        atualizado_por: userId,
      })
      .eq('id', ticketId)
      .eq('company_id', companyId)
      .is('responsavel_id', null)
      .select('*')
      .maybeSingle()

    if (error) return databaseError(res, error, 'Erro ao assumir chamado')
    if (!data) return res.status(409).json({ error: 'Chamado foi assumido por outro usuário' })

    const previousDepartment = await findTenantDepartmentByName(ticket.departamento, companyId)
    const transferResult = await supabase.from('helpdesk_transferencias').insert({
      company_id: companyId,
      ticket_id: ticketId,
      de_departamento_id: previousDepartment?.id || null,
      para_departamento_id: departmentId,
      de_responsavel_id: ticket.responsavel_id,
      para_responsavel_id: userId,
      transferido_por: userId,
      motivo: 'Chamado assumido',
    })
    if (transferResult.error) return databaseError(res, transferResult.error, 'Chamado assumido, mas o histórico não pôde ser registrado')

    await helpDeskNotifications.settleTicketCreated(req, data, 'ticket_assumed')
    await helpDeskNotifications.notifyQueueChanged(
      req,
      data,
      [ticket.departamento, data.departamento],
      'ticket_assumed'
    )
    emitTicketChanged(req, companyId, ticketId, 'ticket_assumed')
    return res.json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao assumir chamado')
  }
}

exports.transferTicket = async (req, res) => {
  try {
    const companyId = req.user.company_id
    const userId = positiveInt(req.user.id)
    const ticketId = positiveInt(req.params.id)
    const departmentId = positiveInt(req.body?.departamento_id)
    const assigneeId = positiveInt(req.body?.responsavel_id)
    const reason = cleanText(req.body?.motivo, 1000) || null

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    if (!departmentId && !assigneeId) {
      return res.status(400).json({ error: 'departamento_id ou responsavel_id é obrigatório' })
    }

    const ticket = await findTicket(ticketId, companyId)
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' })
    if (!(await userCanAccessTicket(req.user, ticket))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }
    const requestedDepartment = departmentId
      ? await findTenantEntity('departamentos', departmentId, companyId, 'id, nome')
      : null
    if (departmentId && !requestedDepartment) return res.status(400).json({ error: 'departamento_id inválido' })
    let assignee = null
    if (assigneeId) {
      assignee = await findTenantEntity('usuarios', assigneeId, companyId, 'id, ativo, departamento_id')
      if (!assignee || assignee.ativo === false) return res.status(400).json({ error: 'responsavel_id inválido' })
    }

    const now = new Date().toISOString()
    const currentDepartment = await findTenantDepartmentByName(ticket.departamento, companyId)
    const assigneeDepartment = !requestedDepartment && assignee?.departamento_id
      ? await findTenantEntity('departamentos', assignee.departamento_id, companyId, 'id, nome')
      : null
    const nextDepartment = requestedDepartment || assigneeDepartment || currentDepartment
    const nextAssigneeId = assigneeId || null
    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .update({
        departamento: nextDepartment?.nome || ticket.departamento || null,
        responsavel_id: nextAssigneeId,
        status: nextAssigneeId ? 'em_atendimento' : 'aberto',
        atribuido_em: nextAssigneeId ? now : null,
        atualizado_em: now,
        atualizado_por: userId,
      })
      .eq('id', ticketId)
      .eq('company_id', companyId)
      .select('*')
      .maybeSingle()
    if (error) return databaseError(res, error, 'Erro ao transferir chamado')
    if (!data) return res.status(409).json({ error: 'Chamado foi alterado por outro usuário' })

    const transferResult = await supabase.from('helpdesk_transferencias').insert({
      company_id: companyId,
      ticket_id: ticketId,
      de_departamento_id: currentDepartment?.id || null,
      para_departamento_id: nextDepartment?.id || null,
      de_responsavel_id: ticket.responsavel_id,
      para_responsavel_id: nextAssigneeId,
      transferido_por: userId,
      motivo: reason,
    })
    if (transferResult.error) return databaseError(res, transferResult.error, 'Chamado transferido, mas o histórico não pôde ser registrado')

    await helpDeskNotifications.settleTicketCreated(req, data, 'ticket_transferred')
    await helpDeskNotifications.settlePreviousAssignee(req, data, ticket.responsavel_id, 'ticket_transferred')
    await helpDeskNotifications.notifyQueueChanged(
      req,
      data,
      [ticket.departamento, data.departamento],
      'ticket_transferred'
    )
    emitTicketChanged(req, companyId, ticketId, 'ticket_transferred')
    await helpDeskNotifications.notifyTicketTransferred(req, data, userId)
    return res.json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao transferir chamado')
  }
}

exports._private = {
  positiveInt,
  cleanText,
  cnpjSearchPattern,
  emitTicketChanged,
  isDepartmentRestrictedUser,
  userDepartmentIds,
  allowedDepartmentNames,
  userCanAccessTicket,
  PRIORITIES,
  STATUSES,
}
