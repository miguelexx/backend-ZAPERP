const supabase = require('../config/supabase')

const PRIORITIES = new Set(['baixa', 'normal', 'alta', 'urgente'])
const STATUSES = new Set(['aberto', 'em_atendimento', 'resolvido'])

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

async function findTicket(id, companyId, integrationCnpj = null) {
  let query = supabase.from('helpdesk_tickets').select('*').eq('id', id).eq('company_id', companyId)
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
    const cnpj = req.helpDeskIntegration ? req.integrationCnpj : cleanText(body.cnpj, 18)
    const requesterName = cleanText(body.solicitante_nome, 180)
    const phone = cleanText(body.telefone, 30) || null
    const operatingSystem = cleanText(body.sistema_operacional, 120) || null
    const machineName = cleanText(body.nome_maquina, 120) || null
    const systemVersion = cleanText(body.versao_sistema, 120) || null
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
        cnpj,
        solicitante_nome: requesterName,
        telefone: phone,
        sistema_operacional: operatingSystem,
        nome_maquina: machineName,
        versao_sistema: systemVersion,
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

    if (status && !STATUSES.has(status)) return res.status(400).json({ error: 'status inválido' })
    if (priority && !PRIORITIES.has(priority)) return res.status(400).json({ error: 'prioridade inválida' })

    let query = supabase
      .from('helpdesk_tickets')
      .select('*, responsavel:usuarios!helpdesk_tickets_responsavel_id_fkey(nome)', { count: 'exact' })
      .eq('company_id', companyId)
      .order('atualizado_em', { ascending: false })
      .range(from, from + limit - 1)

    if (req.helpDeskIntegration) query = query.eq('cnpj', req.integrationCnpj)

    if (status) query = query.eq('status', status)
    if (priority) query = query.eq('prioridade', priority)
    if (cleanText(req.query.departamento, 120)) query = query.ilike('departamento', cleanText(req.query.departamento, 120))
    if (positiveInt(req.query.responsavel_id)) query = query.eq('responsavel_id', positiveInt(req.query.responsavel_id))
    if (search) {
      const safeSearch = search.replace(/[,%()]/g, ' ')
      const filters = [
        `empresa_nome.ilike.%${safeSearch}%`,
        `cnpj.ilike.%${safeSearch}%`,
      ]
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

    const ticket = await findTicket(ticketId, companyId, req.helpDeskIntegration ? req.integrationCnpj : null)
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' })

    let messagesQuery = supabase.from('helpdesk_mensagens').select('*').eq('ticket_id', ticketId).eq('company_id', companyId)
    if (req.helpDeskIntegration) messagesQuery = messagesQuery.eq('interna', false)
    const [messagesResult, transfersResult] = await Promise.all([
      messagesQuery.order('criado_em', { ascending: true }),
      req.helpDeskIntegration
        ? Promise.resolve({ data: [], error: null })
        : supabase.from('helpdesk_transferencias').select('*').eq('ticket_id', ticketId).eq('company_id', companyId).order('criado_em', { ascending: true }),
    ])
    if (messagesResult.error) throw messagesResult.error
    if (transfersResult.error) throw transfersResult.error

    return res.json({
      ...ticket,
      mensagens: messagesResult.data || [],
      transferencias: transfersResult.data || [],
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
    if (!(await findTicket(ticketId, companyId))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    const patch = { atualizado_em: new Date().toISOString(), atualizado_por: userId }
    let changed = false

    if (body.status !== undefined) {
      const status = String(body.status).toLowerCase()
      if (!STATUSES.has(status)) return res.status(400).json({ error: 'status inválido' })
      patch.status = status
      changed = true
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
    const internal = req.helpDeskIntegration ? false : req.body?.interna === true

    if (!ticketId) return res.status(400).json({ error: 'id inválido' })
    if (!message) return res.status(400).json({ error: 'mensagem é obrigatória' })
    if (!(await findTicket(ticketId, companyId, req.helpDeskIntegration ? req.integrationCnpj : null))) {
      return res.status(404).json({ error: 'Chamado não encontrado' })
    }

    const { data, error } = await supabase
      .from('helpdesk_mensagens')
      .insert({ company_id: companyId, ticket_id: ticketId, autor_usuario_id: userId, mensagem: message, interna: internal })
      .select('*')
      .single()
    if (error) return databaseError(res, error, 'Erro ao adicionar mensagem')

    await supabase
      .from('helpdesk_tickets')
      .update({ atualizado_em: new Date().toISOString(), atualizado_por: userId })
      .eq('id', ticketId)
      .eq('company_id', companyId)

    return res.status(201).json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao adicionar mensagem')
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

    return res.json(data)
  } catch (error) {
    return databaseError(res, error, 'Erro ao transferir chamado')
  }
}

exports._private = { positiveInt, cleanText, cnpjSearchPattern, PRIORITIES, STATUSES }
