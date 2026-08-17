const supabase = require('../config/supabase')

function positiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function databaseError(res, error, fallback) {
  console.error('[HelpDesk notificações]', error)
  return res.status(500).json({ error: fallback })
}

exports.listNotifications = async (req, res) => {
  try {
    const companyId = positiveInt(req.user?.company_id)
    const userId = positiveInt(req.user?.id)
    const limit = Math.min(100, Math.max(1, positiveInt(req.query.limit) || 50))
    if (!companyId || !userId) return res.status(401).json({ error: 'Usuário inválido' })

    const departmentIds = [...new Set([
      ...(Array.isArray(req.user?.departamento_ids) ? req.user.departamento_ids : []),
      req.user?.departamento_id,
    ].map(positiveInt).filter(Boolean))]

    const [itemsResult, countResult, departmentsResult] = await Promise.all([
      supabase
        .from('helpdesk_notificacoes')
        .select('id, company_id, usuario_id, ticket_id, tipo, titulo, mensagem, lida, criado_em, lida_em')
        .eq('company_id', companyId)
        .eq('usuario_id', userId)
        .order('criado_em', { ascending: false })
        .limit(limit),
      supabase
        .from('helpdesk_notificacoes')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('usuario_id', userId)
        .eq('lida', false),
      departmentIds.length > 0
        ? supabase
          .from('departamentos')
          .select('nome')
          .eq('company_id', companyId)
          .in('id', departmentIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (itemsResult.error) return databaseError(res, itemsResult.error, 'Erro ao listar notificações')
    if (countResult.error) return databaseError(res, countResult.error, 'Erro ao contar notificações')
    if (departmentsResult.error) return databaseError(res, departmentsResult.error, 'Erro ao localizar departamentos do usuário')

    const departmentNames = [...new Set((departmentsResult.data || []).map((item) => String(item.nome || '').trim()).filter(Boolean))]
    let queueCount = 0
    if (departmentNames.length > 0) {
      const { count, error } = await supabase
        .from('helpdesk_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'aberto')
        .is('responsavel_id', null)
        .in('departamento', departmentNames)
      if (error) return databaseError(res, error, 'Erro ao contar fila do HelpDesk')
      queueCount = count || 0
    }

    const personalUnreadCount = countResult.count || 0
    return res.json({
      items: itemsResult.data || [],
      personal_unread_count: personalUnreadCount,
      queue_count: queueCount,
      unread_count: personalUnreadCount + queueCount,
    })
  } catch (error) {
    return databaseError(res, error, 'Erro ao listar notificações')
  }
}

exports.markTicketRead = async (req, res) => {
  try {
    const companyId = positiveInt(req.user?.company_id)
    const userId = positiveInt(req.user?.id)
    const ticketId = positiveInt(req.params.ticketId)
    if (!companyId || !userId) return res.status(401).json({ error: 'Usuário inválido' })
    if (!ticketId) return res.status(400).json({ error: 'ticketId inválido' })

    const { data, error } = await supabase
      .from('helpdesk_notificacoes')
      .update({ lida: true, lida_em: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('usuario_id', userId)
      .eq('ticket_id', ticketId)
      .eq('lida', false)
      .select('id')

    if (error) return databaseError(res, error, 'Erro ao marcar notificações como lidas')
    return res.json({ ok: true, updated: (data || []).length })
  } catch (error) {
    return databaseError(res, error, 'Erro ao marcar notificações como lidas')
  }
}

exports.markAllRead = async (req, res) => {
  try {
    const companyId = positiveInt(req.user?.company_id)
    const userId = positiveInt(req.user?.id)
    if (!companyId || !userId) return res.status(401).json({ error: 'Usuário inválido' })

    const { data, error } = await supabase
      .from('helpdesk_notificacoes')
      .update({ lida: true, lida_em: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('usuario_id', userId)
      .eq('lida', false)
      .select('id')

    if (error) return databaseError(res, error, 'Erro ao marcar notificações como lidas')
    return res.json({ ok: true, updated: (data || []).length })
  } catch (error) {
    return databaseError(res, error, 'Erro ao marcar notificações como lidas')
  }
}
