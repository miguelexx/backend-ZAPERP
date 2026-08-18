const supabase = require('../config/supabase')

const HELPDESK_NOTIFICATION_EVENT = 'helpdesk:notification'
const HELPDESK_NOTIFICATIONS_CHANGED_EVENT = 'helpdesk:notifications_changed'
const HELPDESK_QUEUE_CHANGED_EVENT = 'helpdesk:queue_changed'

function positiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function compactText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function emitToUser(req, notification) {
  const io = req.app?.get?.('io')
  const userId = positiveInt(notification?.usuario_id)
  if (!io || !userId) return
  io.to?.(`usuario_${userId}`)?.emit?.(HELPDESK_NOTIFICATION_EVENT, notification)
}

function emitQueueChangedToUsers(req, companyId, userIds, ticketId, reason) {
  const io = req.app?.get?.('io')
  const tenantId = positiveInt(companyId)
  const recipients = [...new Set((userIds || []).map(positiveInt).filter(Boolean))]
  if (!io || !tenantId || recipients.length === 0) return
  for (const userId of recipients) {
    io.to?.(`usuario_${userId}`)?.emit?.(HELPDESK_QUEUE_CHANGED_EVENT, {
      company_id: tenantId,
      usuario_id: userId,
      ticket_id: positiveInt(ticketId),
      reason,
    })
  }
}

function emitNotificationsChanged(req, userId, payload) {
  const io = req.app?.get?.('io')
  const recipientId = positiveInt(userId)
  if (!io || !recipientId) return
  io.to?.(`usuario_${recipientId}`)?.emit?.(HELPDESK_NOTIFICATIONS_CHANGED_EVENT, {
    ...payload,
    usuario_id: recipientId,
  })
}

async function markTicketNotificationsRead(req, {
  companyId,
  ticketId,
  userIds = null,
  types = null,
  reason = 'ticket_updated',
}) {
  try {
    const tenantId = positiveInt(companyId)
    const targetTicketId = positiveInt(ticketId)
    if (!tenantId || !targetTicketId) return []

    let updateQuery = supabase
      .from('helpdesk_notificacoes')
      .update({ lida: true, lida_em: new Date().toISOString() })
      .eq('company_id', tenantId)
      .eq('ticket_id', targetTicketId)
      .eq('lida', false)

    const recipients = [...new Set((userIds || []).map(positiveInt).filter(Boolean))]
    if (Array.isArray(userIds) && recipients.length === 0) return []
    if (recipients.length > 0) updateQuery = updateQuery.in('usuario_id', recipients)

    const notificationTypes = [...new Set((types || []).map((value) => compactText(value, 40)).filter(Boolean))]
    if (Array.isArray(types) && notificationTypes.length === 0) return []
    if (notificationTypes.length > 0) updateQuery = updateQuery.in('tipo', notificationTypes)

    const { data, error } = await updateQuery.select('id, usuario_id, ticket_id')
    if (error) throw error

    const rowsByUser = new Map()
    for (const row of data || []) {
      const userId = positiveInt(row.usuario_id)
      if (!userId) continue
      const rows = rowsByUser.get(userId) || []
      rows.push(row)
      rowsByUser.set(userId, rows)
    }
    for (const [userId, rows] of rowsByUser.entries()) {
      emitNotificationsChanged(req, userId, {
        company_id: tenantId,
        ticket_id: targetTicketId,
        notification_ids: rows.map((row) => row.id),
        updated: rows.length,
        reason,
      })
    }
    return data || []
  } catch (error) {
    console.warn('[HelpDesk] Não foi possível encerrar notificações:', error?.message || error)
    return []
  }
}

function settleTicketCreated(req, ticket, reason = 'ticket_assigned') {
  return markTicketNotificationsRead(req, {
    companyId: ticket?.company_id,
    ticketId: ticket?.id,
    types: ['ticket_created'],
    reason,
  })
}

function settlePreviousAssignee(req, ticket, previousAssigneeId, reason = 'ticket_transferred') {
  const userId = positiveInt(previousAssigneeId)
  if (!userId) return Promise.resolve([])
  return markTicketNotificationsRead(req, {
    companyId: ticket?.company_id,
    ticketId: ticket?.id,
    userIds: [userId],
    reason,
  })
}

function settleAllTicketNotifications(req, ticket, reason = 'ticket_resolved') {
  return markTicketNotificationsRead(req, {
    companyId: ticket?.company_id,
    ticketId: ticket?.id,
    reason,
  })
}

async function listActiveUserIds(companyId) {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id')
    .eq('company_id', companyId)
    .eq('ativo', true)

  if (error) throw error
  return (data || []).map((item) => positiveInt(item.id)).filter(Boolean)
}

async function listDepartmentUserIds(companyId, departmentId) {
  const tenantId = positiveInt(companyId)
  const targetDepartmentId = positiveInt(departmentId)
  if (!tenantId || !targetDepartmentId) return []

  const [usersResult, membershipsResult] = await Promise.all([
    supabase
      .from('usuarios')
      .select('id, departamento_id')
      .eq('company_id', tenantId)
      .eq('ativo', true),
    supabase
      .from('usuario_departamentos')
      .select('usuario_id')
      .eq('company_id', tenantId)
      .eq('departamento_id', targetDepartmentId),
  ])

  if (usersResult.error) throw usersResult.error
  if (membershipsResult.error) throw membershipsResult.error
  const memberIds = new Set((membershipsResult.data || []).map((item) => positiveInt(item.usuario_id)).filter(Boolean))
  return (usersResult.data || [])
    .filter((user) => positiveInt(user.departamento_id) === targetDepartmentId || memberIds.has(positiveInt(user.id)))
    .map((user) => positiveInt(user.id))
    .filter(Boolean)
}

async function findDepartmentIdByName(companyId, departmentName) {
  const name = compactText(departmentName, 120)
  if (!name) return null
  const { data, error } = await supabase
    .from('departamentos')
    .select('id')
    .eq('company_id', companyId)
    .ilike('nome', name)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return positiveInt(data?.id)
}

function ephemeralNotification(ticket, userId, type, title, message) {
  return {
    id: null,
    company_id: positiveInt(ticket?.company_id),
    usuario_id: positiveInt(userId),
    ticket_id: positiveInt(ticket?.id),
    tipo: type,
    titulo: compactText(title, 180),
    mensagem: compactText(message, 500) || null,
    lida: false,
    efemera: true,
    criado_em: new Date().toISOString(),
  }
}

async function notifyDepartmentInRealTime(req, { ticket, departmentId, type, title, message, queueReason = null }) {
  try {
    const targetDepartmentId = positiveInt(departmentId) || await findDepartmentIdByName(ticket?.company_id, ticket?.departamento)
    if (!targetDepartmentId) return []
    const userIds = await listDepartmentUserIds(ticket.company_id, targetDepartmentId)
    const notifications = userIds.map((userId) => ephemeralNotification(ticket, userId, type, title, message))
    for (const notification of notifications) emitToUser(req, notification)
    if (queueReason) {
      emitQueueChangedToUsers(req, ticket.company_id, userIds, ticket.id, queueReason)
    }
    return notifications
  } catch (error) {
    console.warn('[HelpDesk] Não foi possível notificar o departamento:', error?.message || error)
    return []
  }
}

async function notifyQueueChanged(req, ticket, departmentNames, reason = 'queue_changed') {
  try {
    const names = [...new Set((departmentNames || []).map((value) => compactText(value, 120)).filter(Boolean))]
    for (const name of names) {
      const departmentId = await findDepartmentIdByName(ticket?.company_id, name)
      if (!departmentId) continue
      const userIds = await listDepartmentUserIds(ticket.company_id, departmentId)
      emitQueueChangedToUsers(req, ticket.company_id, userIds, ticket.id, reason)
    }
  } catch (error) {
    console.warn('[HelpDesk] Não foi possível sincronizar a fila:', error?.message || error)
  }
}

async function createForUsers(req, { companyId, ticket, userIds, type, title, message, actorUserId = null }) {
  try {
    const ticketId = positiveInt(ticket?.id)
    const tenantId = positiveInt(companyId)
    const actorId = positiveInt(actorUserId)
    if (!tenantId || !ticketId) return []

    const recipients = [...new Set((userIds || []).map(positiveInt).filter((id) => id && id !== actorId))]
    if (recipients.length === 0) return []

    const rows = recipients.map((userId) => ({
      company_id: tenantId,
      usuario_id: userId,
      ticket_id: ticketId,
      tipo: type,
      titulo: compactText(title, 180),
      mensagem: compactText(message, 500) || null,
    }))

    const { data, error } = await supabase
      .from('helpdesk_notificacoes')
      .insert(rows)
      .select('id, company_id, usuario_id, ticket_id, tipo, titulo, mensagem, lida, criado_em')

    if (error) throw error
    for (const notification of data || []) emitToUser(req, notification)
    return data || []
  } catch (error) {
    console.warn('[HelpDesk] Não foi possível registrar notificação:', error?.message || error)
    return []
  }
}

async function notifyTicketCreated(req, ticket, departmentId = null) {
  return notifyDepartmentInRealTime(req, {
    ticket,
    departmentId,
    type: 'ticket_created',
    title: `Novo chamado #${ticket.id}`,
    message: `${ticket.empresa_nome || 'Empresa não informada'} — ${ticket.titulo || 'Sem assunto'}`,
    queueReason: 'ticket_created',
  })
}

async function notifyExternalMessage(req, ticket, requesterName) {
  try {
    const assignedUserId = positiveInt(ticket.responsavel_id)
    if (!assignedUserId) {
      return notifyDepartmentInRealTime(req, {
        ticket,
        type: 'message_created',
        title: `Nova mensagem no chamado #${ticket.id}`,
        message: `${compactText(requesterName, 180) || 'Cliente'} respondeu: ${ticket.titulo || 'Sem assunto'}`,
      })
    }
    return createForUsers(req, {
      companyId: ticket.company_id,
      ticket,
      userIds: [assignedUserId],
      type: 'message_created',
      title: `Nova mensagem no chamado #${ticket.id}`,
      message: `${compactText(requesterName, 180) || 'Cliente'} respondeu: ${ticket.titulo || 'Sem assunto'}`,
    })
  } catch (error) {
    console.warn('[HelpDesk] Não foi possível localizar destinatários:', error?.message || error)
    return []
  }
}

async function notifyTicketTransferred(req, ticket, actorUserId) {
  const assignedUserId = positiveInt(ticket.responsavel_id)
  if (!assignedUserId) return []
  return createForUsers(req, {
    companyId: ticket.company_id,
    ticket,
    userIds: [assignedUserId],
    actorUserId,
    type: 'ticket_transferred',
    title: `Chamado #${ticket.id} transferido para você`,
    message: `${ticket.empresa_nome || 'Empresa não informada'} — ${ticket.titulo || 'Sem assunto'}`,
  })
}

module.exports = {
  HELPDESK_NOTIFICATION_EVENT,
  HELPDESK_NOTIFICATIONS_CHANGED_EVENT,
  HELPDESK_QUEUE_CHANGED_EVENT,
  createForUsers,
  listDepartmentUserIds,
  notifyQueueChanged,
  markTicketNotificationsRead,
  settleTicketCreated,
  settlePreviousAssignee,
  settleAllTicketNotifications,
  notifyTicketCreated,
  notifyExternalMessage,
  notifyTicketTransferred,
}
