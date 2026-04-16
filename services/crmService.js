/**
 * Regras de negócio CRM — validação de tenant, movimentação Kanban, estágios terminais.
 */
const supabase = require('../config/supabase')
const { registrar } = require('../helpers/auditoriaLog')
const { normalizePhoneBR } = require('../helpers/phoneHelper')
const repo = require('../repositories/crmRepository')
const crmGoogle = require('./crmGoogleService')

async function ensureDefaultCrmSetup(companyId) {
  const pipes = await repo.listPipelines(companyId, {})
  if (pipes.length > 0) return pipes[0]

  const p = await repo.insertPipeline({
    company_id: companyId,
    nome: 'Vendas',
    descricao: 'Pipeline padrão do CRM',
    cor: '#6366f1',
    ativo: true,
    ordem: 0,
    padrao: true,
  })
  await repo.clearPadraoExcept(companyId, p.id)

  const defs = [
    { nome: 'Novo', descricao: 'Novos leads', cor: '#94a3b8', ordem: 10, tipo_fechamento: null, exige_motivo_perda: false, inicial: true },
    { nome: 'Qualificação', descricao: 'Qualificação', cor: '#3b82f6', ordem: 20, tipo_fechamento: null, exige_motivo_perda: false },
    { nome: 'Proposta', descricao: 'Proposta enviada', cor: '#f59e0b', ordem: 30, tipo_fechamento: null, exige_motivo_perda: false },
    { nome: 'Negociação', descricao: 'Negociação', cor: '#a855f7', ordem: 40, tipo_fechamento: null, exige_motivo_perda: false },
    { nome: 'Ganho', descricao: 'Negócio ganho', cor: '#22c55e', ordem: 50, tipo_fechamento: 'ganho', exige_motivo_perda: false },
    { nome: 'Perdido', descricao: 'Negócio perdido', cor: '#ef4444', ordem: 60, tipo_fechamento: 'perdido', exige_motivo_perda: true },
  ]

  for (const d of defs) {
    await repo.insertStage({
      company_id: companyId,
      pipeline_id: p.id,
      nome: d.nome,
      descricao: d.descricao,
      cor: d.cor,
      ordem: d.ordem,
      tipo_fechamento: d.tipo_fechamento,
      exige_motivo_perda: d.exige_motivo_perda,
      ativo: true,
      inicial: !!d.inicial,
    })
  }
  return p
}

function terminalPatchFromStage(stage, { motivoPerda } = {}) {
  if (!stage) return {}
  if (stage.tipo_fechamento === 'ganho') {
    return {
      status: 'ganho',
      ganho_em: new Date().toISOString(),
      perdido_em: null,
      perdido_motivo: null,
    }
  }
  if (stage.tipo_fechamento === 'perdido') {
    return {
      status: 'perdido',
      perdido_em: new Date().toISOString(),
      ganho_em: null,
      perdido_motivo: motivoPerda != null ? String(motivoPerda).trim() || null : null,
    }
  }
  return {
    status: 'ativo',
    ganho_em: null,
    perdido_em: null,
    perdido_motivo: null,
  }
}

async function assertClienteConversaCompany(companyId, clienteId, conversaId) {
  if (clienteId != null) {
    const { data, error } = await supabase
      .from('clientes')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', clienteId)
      .maybeSingle()
    if (error) throw error
    if (!data) throw Object.assign(new Error('Cliente não encontrado na empresa'), { status: 400 })
  }
  if (conversaId != null) {
    const { data, error } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', conversaId)
      .maybeSingle()
    if (error) throw error
    if (!data) throw Object.assign(new Error('Conversa não encontrada na empresa'), { status: 400 })
  }
}

async function tryResolveClienteFromTelefone(companyId, telefone) {
  if (!telefone || !String(telefone).trim()) return null
  let norm
  try {
    norm = normalizePhoneBR(String(telefone).trim())
  } catch (_) {
    norm = String(telefone).trim()
  }
  const { data } = await supabase
    .from('clientes')
    .select('id')
    .eq('company_id', companyId)
    .eq('telefone', norm)
    .maybeSingle()
  return data?.id ?? null
}

async function createLead(companyId, userId, body, audit = true) {
  let pipelineId = body.pipeline_id != null ? Number(body.pipeline_id) : null
  let pipeline = pipelineId ? await repo.getPipelineById(companyId, pipelineId) : null
  if (!pipeline) {
    pipeline = await ensureDefaultCrmSetup(companyId)
    pipelineId = pipeline.id
  }

  let stageId = body.stage_id != null ? Number(body.stage_id) : null
  let stage = stageId ? await repo.getStageById(companyId, stageId) : null
  if (!stage || stage.pipeline_id !== pipelineId) {
    stage = await repo.getFirstOpenStage(companyId, pipelineId)
  }
  if (!stage) throw Object.assign(new Error('Nenhum estágio aberto no pipeline'), { status: 400 })

  let clienteId = body.cliente_id != null ? Number(body.cliente_id) : null
  let conversaId = body.conversa_id != null ? Number(body.conversa_id) : null

  if (body.vincular_cliente_por_telefone === true && !clienteId && body.telefone) {
    const guess = await tryResolveClienteFromTelefone(companyId, body.telefone)
    if (guess) clienteId = guess
  }

  await assertClienteConversaCompany(companyId, clienteId, conversaId)

  const maxO = await repo.maxOrdemInStage(companyId, stage.id)
  const nome = String(body.nome || '').trim()
  if (!nome) throw Object.assign(new Error('nome é obrigatório'), { status: 400 })

  const row = {
    company_id: companyId,
    cliente_id: clienteId,
    conversa_id: conversaId,
    pipeline_id: pipelineId,
    stage_id: stage.id,
    responsavel_id: body.responsavel_id !== undefined
      ? (body.responsavel_id != null ? Number(body.responsavel_id) : null)
      : userId,
    origem_id: body.origem_id != null ? Number(body.origem_id) : null,
    nome,
    empresa: body.empresa != null ? String(body.empresa).trim() : null,
    telefone: body.telefone != null ? String(body.telefone).trim() : null,
    email: body.email != null ? String(body.email).trim() : null,
    valor_estimado: body.valor_estimado != null ? Number(body.valor_estimado) : null,
    probabilidade: body.probabilidade != null ? Number(body.probabilidade) : null,
    prioridade: body.prioridade || 'normal',
    status: 'ativo',
    data_proximo_contato: body.data_proximo_contato || null,
    ultima_interacao_em: new Date().toISOString(),
    observacoes: body.observacoes != null ? String(body.observacoes) : null,
    ordem: maxO + 1,
    criado_por: userId,
    ...terminalPatchFromStage(stage, {}),
  }

  const lead = await repo.insertLead(row)
  if (Array.isArray(body.tag_ids) && body.tag_ids.length) {
    const tagIds = [...new Set(body.tag_ids.map(Number).filter((x) => Number.isFinite(x)))]
    await repo.replaceLeadTags(companyId, lead.id, tagIds)
  }

  if (audit) {
    await registrar({
      company_id: companyId,
      usuario_id: userId,
      acao: 'crm_lead_criar',
      entidade: 'crm_lead',
      entidade_id: lead.id,
      detalhes_json: { pipeline_id: pipelineId, stage_id: stage.id },
    })
  }

  return repo.getLeadById(companyId, lead.id).then(async (l) => {
    const { byLead } = await repo.fetchTagsForLeads(companyId, [l.id])
    return { ...l, tags: byLead[l.id] || [] }
  })
}

async function updateLead(companyId, userId, leadId, body) {
  const existing = await repo.getLeadById(companyId, leadId)
  if (!existing) throw Object.assign(new Error('Lead não encontrado'), { status: 404 })

  const patch = {}
  const fields = [
    'nome', 'empresa', 'telefone', 'email', 'valor_estimado', 'probabilidade', 'prioridade',
    'observacoes', 'data_proximo_contato', 'cliente_id', 'conversa_id', 'origem_id',
  ]
  for (const f of fields) {
    if (body[f] !== undefined) patch[f] = body[f]
  }
  if (body.responsavel_id !== undefined) {
    const prev = existing.responsavel_id
    const next = body.responsavel_id != null ? Number(body.responsavel_id) : null
    patch.responsavel_id = next
    if (prev !== next) {
      await registrar({
        company_id: companyId,
        usuario_id: userId,
        acao: 'crm_lead_responsavel',
        entidade: 'crm_lead',
        entidade_id: leadId,
        detalhes_json: { de: prev, para: next },
      })
    }
  }

  if (patch.cliente_id !== undefined || patch.conversa_id !== undefined) {
    await assertClienteConversaCompany(
      companyId,
      patch.cliente_id !== undefined ? patch.cliente_id : existing.cliente_id,
      patch.conversa_id !== undefined ? patch.conversa_id : existing.conversa_id
    )
  }

  if (body.status !== undefined) {
    const st = String(body.status).toLowerCase()
    if (['ativo', 'arquivado', 'ganho', 'perdido'].includes(st)) {
      patch.status = st
    }
  }

  patch.ultima_interacao_em = new Date().toISOString()
  const updated = await repo.updateLead(companyId, leadId, patch)
  if (Array.isArray(body.tag_ids)) {
    const tagIds = [...new Set(body.tag_ids.map(Number).filter((x) => Number.isFinite(x)))]
    await repo.replaceLeadTags(companyId, leadId, tagIds)
  }

  await registrar({
    company_id: companyId,
    usuario_id: userId,
    acao: 'crm_lead_editar',
    entidade: 'crm_lead',
    entidade_id: leadId,
    detalhes_json: { campos: Object.keys(body) },
  })

  const { byLead } = await repo.fetchTagsForLeads(companyId, [leadId])
  return { ...updated, tags: byLead[leadId] || [] }
}

async function moveLead(companyId, userId, leadId, body) {
  const lead = await repo.getLeadById(companyId, leadId)
  if (!lead) throw Object.assign(new Error('Lead não encontrado'), { status: 404 })

  const pipelineId = body.pipeline_id != null ? Number(body.pipeline_id) : lead.pipeline_id
  const stageId = body.stage_id != null ? Number(body.stage_id) : null
  if (!stageId) throw Object.assign(new Error('stage_id é obrigatório'), { status: 400 })

  if (lead.pipeline_id !== pipelineId && body.bloquear_cruzamento_pipeline === true) {
    throw Object.assign(new Error('Mudança de pipeline não permitida para este lead'), { status: 400 })
  }

  const pipeline = await repo.getPipelineById(companyId, pipelineId)
  if (!pipeline) throw Object.assign(new Error('Pipeline inválido'), { status: 400 })

  const stage = await repo.getStageById(companyId, stageId)
  if (!stage || stage.pipeline_id !== pipelineId) {
    throw Object.assign(new Error('Estágio não pertence ao pipeline'), { status: 400 })
  }

  if (stage.tipo_fechamento === 'perdido' && stage.exige_motivo_perda) {
    const m = body.motivo_perda ?? body.perdido_motivo
    if (!m || !String(m).trim()) {
      throw Object.assign(new Error('Motivo de perda obrigatório para este estágio'), { status: 400 })
    }
  }

  const motivoPerda = body.motivo_perda ?? body.perdido_motivo ?? null
  const terminal = terminalPatchFromStage(stage, { motivoPerda })

  let newOrdem
  if (body.ordem !== undefined && body.ordem !== null) {
    newOrdem = Number(body.ordem)
  } else {
    newOrdem = (await repo.maxOrdemInStage(companyId, stageId)) + 1
  }

  const movement = {
    company_id: companyId,
    lead_id: leadId,
    de_stage_id: lead.stage_id,
    para_stage_id: stageId,
    de_pipeline_id: lead.pipeline_id,
    para_pipeline_id: pipelineId,
    movido_por: userId,
    motivo: body.motivo != null ? String(body.motivo) : null,
  }
  await repo.insertMovement(movement)

  const updated = await repo.updateLead(companyId, leadId, {
    pipeline_id: pipelineId,
    stage_id: stageId,
    ordem: newOrdem,
    ultima_interacao_em: new Date().toISOString(),
    ...terminal,
    ...(stage.tipo_fechamento === 'perdido' && motivoPerda
      ? { perdido_motivo: String(motivoPerda).trim() }
      : {}),
  })

  await registrar({
    company_id: companyId,
    usuario_id: userId,
    acao: 'crm_lead_mover',
    entidade: 'crm_lead',
    entidade_id: leadId,
    detalhes_json: {
      de: { pipeline_id: lead.pipeline_id, stage_id: lead.stage_id },
      para: { pipeline_id: pipelineId, stage_id: stageId },
    },
  })

  return updated
}

async function getColumnTotalsForPipeline(companyId, pipelineId) {
  const stages = await repo.listStages(companyId, { pipeline_id: pipelineId, ativo: true })
  const totals = await repo.countLeadsByStages(
    companyId,
    stages.map((s) => s.id)
  )
  return stages.map((s) => ({
    stage_id: s.id,
    nome: s.nome,
    ordem: s.ordem,
    total: totals[s.id] || 0,
  }))
}

async function reorderLeads(companyId, userId, body) {
  const stageId = Number(body.stage_id)
  const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids.map(Number) : []
  if (!Number.isFinite(stageId) || leadIds.length === 0) {
    throw Object.assign(new Error('stage_id e lead_ids são obrigatórios'), { status: 400 })
  }

  const stage = await repo.getStageById(companyId, stageId)
  if (!stage) throw Object.assign(new Error('Estágio inválido'), { status: 400 })

  const inStage = await repo.listLeadsByStage(companyId, stageId)
  const setOk = new Set(inStage.map((l) => l.id))
  for (const id of leadIds) {
    if (!setOk.has(id)) throw Object.assign(new Error(`Lead ${id} não está no estágio`), { status: 400 })
  }
  if (leadIds.length !== inStage.length) {
    throw Object.assign(new Error('Lista incompleta de leads do estágio'), { status: 400 })
  }

  for (let i = 0; i < leadIds.length; i++) {
    await repo.updateLead(companyId, leadIds[i], { ordem: i })
  }

  await registrar({
    company_id: companyId,
    usuario_id: userId,
    acao: 'crm_kanban_reordenar',
    entidade: 'crm_stage',
    entidade_id: stageId,
    detalhes_json: { ordem: leadIds },
  })

  return { ok: true }
}

async function getKanban(companyId, pipelineId) {
  await ensureDefaultCrmSetup(companyId)
  let pid = pipelineId != null && pipelineId !== '' ? Number(pipelineId) : null
  if (pid != null && !Number.isFinite(pid)) pid = null

  let pipeline
  if (pid) {
    pipeline = await repo.getPipelineById(companyId, pid)
    if (!pipeline) throw Object.assign(new Error('Pipeline não encontrado'), { status: 404 })
  } else {
    pipeline = await repo.getDefaultPipeline(companyId)
  }
  if (!pipeline) throw Object.assign(new Error('Pipeline não encontrado'), { status: 404 })

  const stages = await repo.listStages(companyId, { pipeline_id: pipeline.id, ativo: true })
  const leads = await repo.listLeadsByPipeline(companyId, pipeline.id)
  const leadIds = leads.map((l) => l.id)
  const { byLead } = await repo.fetchTagsForLeads(companyId, leadIds)
  const userMap = await repo.fetchUsuarioMap(companyId, leads.map((l) => l.responsavel_id).filter(Boolean))

  const byStage = {}
  stages.forEach((s) => { byStage[s.id] = [] })
  leads.forEach((l) => {
    if (!byStage[l.stage_id]) byStage[l.stage_id] = []
    byStage[l.stage_id].push(l)
  })

  const columns = stages.map((s) => {
    const colLeads = (byStage[s.id] || []).sort((a, b) => (a.ordem - b.ordem) || (a.id - b.id))
    const cards = colLeads.map((l) => ({
      id: l.id,
      nome: l.nome,
      empresa: l.empresa,
      telefone: l.telefone,
      email: l.email,
      valor_estimado: l.valor_estimado,
      probabilidade: l.probabilidade,
      prioridade: l.prioridade,
      status: l.status,
      data_proximo_contato: l.data_proximo_contato,
      ultima_interacao_em: l.ultima_interacao_em,
      stage_id: l.stage_id,
      pipeline_id: l.pipeline_id,
      ordem: l.ordem,
      responsavel: l.responsavel_id ? userMap[l.responsavel_id] || { id: l.responsavel_id, nome: null } : null,
      tags: byLead[l.id] || [],
    }))
    return {
      stage: s,
      total: cards.length,
      leads: cards,
    }
  })

  return { pipeline, columns }
}

async function getDashboard(companyId, query) {
  let pipelineId = query.pipeline_id != null && query.pipeline_id !== '' ? Number(query.pipeline_id) : null
  if (!pipelineId || !Number.isFinite(pipelineId)) {
    const pipes = await repo.listPipelines(companyId, { ativo: true })
    pipelineId = pipes[0]?.id ?? null
  }

  const qBase = {}
  if (pipelineId) qBase.pipeline_id = pipelineId

  const total = await repo.countLeads(companyId, { ...qBase, status: undefined })
  const ativos = await repo.countLeads(companyId, { ...qBase, status: 'ativo' })
  const ganhos = await repo.countLeads(companyId, { ...qBase, status: 'ganho' })
  const perdidos = await repo.countLeads(companyId, { ...qBase, status: 'perdido' })
  const arquivados = await repo.countLeads(companyId, { ...qBase, status: 'arquivado' })

  let sumQ = supabase
    .from('crm_leads')
    .select('valor_estimado')
    .eq('company_id', companyId)
    .eq('status', 'ativo')
  if (pipelineId) sumQ = sumQ.eq('pipeline_id', pipelineId)
  const { data: sumRows, error } = await sumQ
  if (error) throw error
  let valorPipeline = 0
  ;(sumRows || []).forEach((r) => {
    if (r.valor_estimado != null) valorPipeline += Number(r.valor_estimado)
  })

  const stages = pipelineId
    ? await repo.listStages(companyId, { pipeline_id: pipelineId, ativo: true })
    : []
  const stageIds = stages.map((s) => s.id)
  const counts = await repo.countLeadsByStages(companyId, stageIds)

  return {
    pipeline_id: pipelineId,
    totais: { todos: total, ativos, ganhos, perdidos, arquivados },
    valor_estimado_soma_ativos: valorPipeline,
    por_estagio: stages.map((s) => ({ stage_id: s.id, nome: s.nome, total: counts[s.id] || 0 })),
  }
}

function buildActivityGoogleDescription(lead, activity) {
  const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '')
  const lines = []
  if (activity.descricao) lines.push(String(activity.descricao).trim())
  if (lead.observacoes) {
    lines.push('')
    lines.push('Observações do lead:')
    lines.push(String(lead.observacoes).trim())
  }
  lines.push('')
  lines.push('— ZapERP CRM —')
  if (base) {
    lines.push(`Lead #${lead.id} (referência interna — abrir no app CRM)`)
    if (lead.conversa_id) lines.push(`Conversa WhatsApp #${lead.conversa_id}`)
    if (lead.cliente_id) lines.push(`Cliente #${lead.cliente_id}`)
  }
  return lines.join('\n')
}

async function syncActivityToGoogle(companyId, usuarioId, activity, lead) {
  try {
    const tokens = await repo.getGoogleTokens(companyId, usuarioId)
    if (!tokens || !tokens.ativo) return { synced: false, reason: 'sem_google' }

    const calId = tokens.calendar_id || 'primary'
    const start = activity.data_agendada
    if (!start) return { synced: false, reason: 'sem_data' }

    const tz = activity.timezone && String(activity.timezone).trim()
      ? String(activity.timezone).trim()
      : 'America/Sao_Paulo'
    const startDate = new Date(start)
    let endDate
    if (activity.data_fim) {
      endDate = new Date(activity.data_fim)
      if (endDate <= startDate) {
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000)
      }
    } else {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000)
    }

    let participantes = activity.participantes
    if (typeof participantes === 'string') {
      try {
        participantes = JSON.parse(participantes)
      } catch (_) {
        participantes = []
      }
    }
    if (!Array.isArray(participantes)) participantes = []

    const description = buildActivityGoogleDescription(lead, activity)
    const ev = await crmGoogle.createOrUpdateEvent(companyId, usuarioId, {
      calendarId: calId,
      eventId: activity.google_event_id || undefined,
      summary: `[CRM] ${lead.nome} — ${activity.titulo}`,
      description,
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
      timeZone: tz,
      attendees: participantes,
    })
    const patch = {
      google_event_id: ev.id || activity.google_event_id,
      google_html_link: ev.htmlLink != null ? String(ev.htmlLink) : null,
    }
    await repo.updateAtividade(companyId, activity.id, patch)
    await registrar({
      company_id: companyId,
      usuario_id: usuarioId,
      acao: 'crm_google_sync_atividade',
      entidade: 'crm_atividade',
      entidade_id: activity.id,
      detalhes_json: { google_event_id: patch.google_event_id, html: !!ev.htmlLink },
    })
    return { synced: true, google_event_id: patch.google_event_id, html_link: ev.htmlLink || null }
  } catch (e) {
    await repo.insertGoogleLog({
      company_id: companyId,
      usuario_id: usuarioId,
      lead_id: activity.lead_id,
      atividade_id: activity.id,
      tipo: 'sync_erro',
      mensagem: e?.message || String(e),
      detalhes_json: {},
    })
    await registrar({
      company_id: companyId,
      usuario_id: usuarioId,
      acao: 'crm_google_sync_erro',
      entidade: 'crm_atividade',
      entidade_id: activity.id,
      detalhes_json: { erro: e?.message || String(e) },
    })
    throw e
  }
}

async function removeActivityFromGoogle(companyId, usuarioId, activity) {
  if (!activity?.google_event_id) return { removed: false }
  try {
    const tokens = await repo.getGoogleTokens(companyId, usuarioId)
    if (!tokens?.ativo) return { removed: false, reason: 'sem_google' }
    const calId = tokens.calendar_id || 'primary'
    await crmGoogle.deleteEvent(companyId, usuarioId, calId, activity.google_event_id)
    return { removed: true }
  } catch (e) {
    await repo.insertGoogleLog({
      company_id: companyId,
      usuario_id: usuarioId,
      lead_id: activity.lead_id,
      atividade_id: activity.id,
      tipo: 'delete_erro',
      mensagem: e?.message || String(e),
      detalhes_json: {},
    })
    return { removed: false, erro: e?.message || String(e) }
  }
}

async function syncLeadToGoogle(companyId, usuarioId, leadId) {
  const lead = await repo.getLeadById(companyId, leadId)
  if (!lead) throw Object.assign(new Error('Lead não encontrado'), { status: 404 })
  const ats = await repo.listAtividades(companyId, leadId)
  const out = []
  for (const a of ats) {
    if (!a.data_agendada || a.status === 'cancelada') continue
    try {
      const fresh = await repo.getAtividadeById(companyId, a.id)
      const r = await syncActivityToGoogle(companyId, usuarioId, fresh || a, lead)
      out.push({ atividade_id: a.id, ...r })
    } catch (e) {
      out.push({ atividade_id: a.id, synced: false, erro: e?.message || String(e) })
    }
  }
  return out
}

async function enrichLeadRows(companyId, rows) {
  if (!rows.length) return []
  const ids = rows.map((l) => l.id)
  const [notasC, ativC, proxA] = await Promise.all([
    repo.countNotasByLeadIds(companyId, ids),
    repo.countAtividadesByLeadIds(companyId, ids),
    repo.fetchProximaAtividadePendenteByLeadIds(companyId, ids),
  ])
  const pipIds = [...new Set(rows.map((l) => l.pipeline_id).filter(Boolean))]
  const stIds = [...new Set(rows.map((l) => l.stage_id).filter(Boolean))]
  const oriIds = [...new Set(rows.map((l) => l.origem_id).filter(Boolean))]
  const cliIds = [...new Set(rows.map((l) => l.cliente_id).filter(Boolean))]
  const convIds = [...new Set(rows.map((l) => l.conversa_id).filter(Boolean))]
  const [pipMap, stMap, oriMap, cliMap, convMap, userMap] = await Promise.all([
    repo.fetchPipelineMap(companyId, pipIds),
    repo.fetchStageMap(companyId, stIds),
    repo.fetchOrigemMap(companyId, oriIds),
    repo.fetchClienteMap(companyId, cliIds),
    repo.fetchConversaMap(companyId, convIds),
    repo.fetchUsuarioMap(companyId, rows.map((l) => l.responsavel_id).filter(Boolean)),
  ])
  return rows.map((l) => ({
    ...l,
    responsavel: l.responsavel_id ? userMap[l.responsavel_id] || { id: l.responsavel_id, nome: null } : null,
    pipeline: pipMap[l.pipeline_id] || null,
    stage: stMap[l.stage_id] || null,
    origem: l.origem_id ? oriMap[l.origem_id] || null : null,
    cliente: l.cliente_id ? cliMap[l.cliente_id] || null : null,
    conversa: l.conversa_id ? convMap[l.conversa_id] || null : null,
    totais: {
      notas: notasC[l.id] || 0,
      atividades: ativC[l.id] || 0,
    },
    proxima_atividade: proxA[l.id] || null,
    situacao: l.status,
  }))
}

async function listLeadsEnriched(companyId, query) {
  const result = await repo.listLeads(companyId, query)
  const items = await enrichLeadRows(companyId, result.items)
  return { ...result, items }
}

async function getLeadDetailEnriched(companyId, leadId) {
  const lead = await repo.getLeadById(companyId, leadId)
  if (!lead) return null
  const [enriched] = await enrichLeadRows(companyId, [lead])
  const notas = await repo.listNotas(companyId, leadId)
  const ats = await repo.listAtividades(companyId, leadId)
  const mov = await repo.listMovements(companyId, leadId, { limit: 100 })
  const { byLead } = await repo.fetchTagsForLeads(companyId, [leadId])
  return {
    ...enriched,
    tags: byLead[leadId] || [],
    notas,
    atividades: ats,
    historico: mov,
  }
}

function groupByDayIso(rows, dateField) {
  const g = {}
  ;(rows || []).forEach((r) => {
    const d = r[dateField]
    if (!d) return
    const key = String(d).slice(0, 10)
    if (!g[key]) g[key] = []
    g[key].push(r)
  })
  return g
}

async function getAgendaComercial(companyId, query) {
  const de = query.de || query.from
  const ate = query.ate || query.to
  if (!de || !ate) throw Object.assign(new Error('Informe de e ate (ISO)'), { status: 400 })
  const responsavel_id = query.responsavel_id != null ? Number(query.responsavel_id) : undefined
  const status = query.status || undefined
  const tipo = query.tipo || undefined
  const pipeline_id = query.pipeline_id != null && query.pipeline_id !== '' ? Number(query.pipeline_id) : null
  const stage_id = query.stage_id != null && query.stage_id !== '' ? Number(query.stage_id) : null

  let atividades = await repo.listAtividadesAgenda(companyId, {
    de: String(de),
    ate: String(ate),
    responsavel_id,
    status,
    tipo,
  })

  const leadIds = [...new Set(atividades.map((a) => a.lead_id))]
  let leadRows = []
  if (leadIds.length) {
    const { data, error: le } = await supabase
      .from('crm_leads')
      .select('id, nome, empresa, pipeline_id, stage_id, responsavel_id, status, telefone')
      .eq('company_id', companyId)
      .in('id', leadIds)
    if (le) throw le
    leadRows = data || []
  }
  const leadMap = {}
  leadRows.forEach((l) => { leadMap[l.id] = l })

  atividades = atividades.filter((a) => {
    const L = leadMap[a.lead_id]
    if (!L) return false
    if (pipeline_id != null && Number.isFinite(pipeline_id) && L.pipeline_id !== pipeline_id) return false
    if (stage_id != null && Number.isFinite(stage_id) && L.stage_id !== stage_id) return false
    return true
  })

  const proximos = await repo.listProximosContatosAgenda(companyId, {
    de: String(de),
    ate: String(ate),
    responsavel_id,
  })
  let proxFiltrados = proximos
  if (pipeline_id != null && Number.isFinite(pipeline_id)) {
    proxFiltrados = proxFiltrados.filter((p) => p.pipeline_id === pipeline_id)
  }
  if (stage_id != null && Number.isFinite(stage_id)) {
    proxFiltrados = proxFiltrados.filter((p) => p.stage_id === stage_id)
  }

  const por_dia_atividades = groupByDayIso(atividades, 'data_agendada')
  const por_dia_proximos = groupByDayIso(proxFiltrados, 'data_proximo_contato')

  const enrichedActs = atividades.map((a) => ({
    ...a,
    lead: leadMap[a.lead_id] || null,
    origem_google: a.google_event_id ? 'google' : 'local',
  }))

  return {
    periodo: { de, ate },
    filtros: { pipeline_id, stage_id, responsavel_id, status, tipo },
    por_dia: {
      atividades: por_dia_atividades,
      proximos_contatos: por_dia_proximos,
    },
    lista: {
      atividades: enrichedActs,
      proximos_contatos: proxFiltrados,
    },
  }
}

async function getAgendaResumo(companyId) {
  const now = new Date()
  const in7 = new Date(now.getTime() + 7 * 86400000).toISOString()
  const pend = await repo.countAtividadesByStatus(companyId, { status: 'pendente' })
  const { count: prox7, error: e1 } = await supabase
    .from('crm_atividades')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'pendente')
    .not('data_agendada', 'is', null)
    .gte('data_agendada', now.toISOString())
    .lte('data_agendada', in7)
  if (e1) throw e1
  const { count: atrasadas, error: e2 } = await supabase
    .from('crm_atividades')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'pendente')
    .not('data_agendada', 'is', null)
    .lt('data_agendada', now.toISOString())
  if (e2) throw e2
  const vencidos = await repo.countLeads(companyId, {
    proximo_vencido: true,
  })
  return {
    atividades_pendentes_total: pend,
    atividades_pendentes_proximos_7_dias: prox7 || 0,
    atividades_atrasadas: atrasadas || 0,
    leads_proximo_contato_vencido: vencidos,
  }
}

async function getDashboardFunnel(companyId, query) {
  const de = query.criado_de || query.de
  const ate = query.criado_ate || query.ate
  let pipelineId = query.pipeline_id != null ? Number(query.pipeline_id) : null
  if (!pipelineId || !Number.isFinite(pipelineId)) {
    const p = await repo.getDefaultPipeline(companyId)
    pipelineId = p?.id ?? null
  }
  if (!pipelineId) return { pipeline_id: null, novos_no_periodo_por_estagio: [], total_novos: 0 }

  let q = supabase
    .from('crm_leads')
    .select('stage_id, criado_em')
    .eq('company_id', companyId)
    .eq('pipeline_id', pipelineId)
  if (de) q = q.gte('criado_em', String(de))
  if (ate) q = q.lte('criado_em', String(ate))
  const { data, error } = await q
  if (error) throw error
  const stages = await repo.listStages(companyId, { pipeline_id: pipelineId, ativo: true })
  const byStage = {}
  stages.forEach((s) => { byStage[s.id] = { stage_id: s.id, nome: s.nome, ordem: s.ordem, novos: 0 } })
  ;(data || []).forEach((r) => {
    if (byStage[r.stage_id]) byStage[r.stage_id].novos += 1
  })
  return {
    pipeline_id: pipelineId,
    periodo: { de: de || null, ate: ate || null },
    total_novos: (data || []).length,
    novos_no_periodo_por_estagio: Object.values(byStage).sort((a, b) => a.ordem - b.ordem),
  }
}

async function getDashboardResponsaveis(companyId, query) {
  let pipelineId = query.pipeline_id != null ? Number(query.pipeline_id) : null
  if (!pipelineId || !Number.isFinite(pipelineId)) pipelineId = null
  let q = supabase
    .from('crm_leads')
    .select('responsavel_id, valor_estimado, status')
    .eq('company_id', companyId)
    .eq('status', 'ativo')
  if (pipelineId) q = q.eq('pipeline_id', pipelineId)
  const { data, error } = await q
  if (error) throw error
  const agg = {}
  ;(data || []).forEach((r) => {
    const k = r.responsavel_id != null ? r.responsavel_id : 'sem_responsavel'
    if (!agg[k]) agg[k] = { responsavel_id: r.responsavel_id, total_leads: 0, valor_potencial: 0 }
    agg[k].total_leads += 1
    if (r.valor_estimado != null) agg[k].valor_potencial += Number(r.valor_estimado)
  })
  const ids = Object.keys(agg).filter((x) => x !== 'sem_responsavel' && Number.isFinite(Number(x))).map(Number)
  const umap = await repo.fetchUsuarioMap(companyId, ids)
  const lista = Object.values(agg).map((row) => ({
    ...row,
    responsavel: row.responsavel_id ? umap[row.responsavel_id] || { id: row.responsavel_id, nome: null } : null,
  }))
  lista.sort((a, b) => b.valor_potencial - a.valor_potencial)
  return { pipeline_id: pipelineId, ranking: lista }
}

async function getDashboardOrigens(companyId, query) {
  let pipelineId = query.pipeline_id != null ? Number(query.pipeline_id) : null
  if (!pipelineId || !Number.isFinite(pipelineId)) pipelineId = null
  let q = supabase
    .from('crm_leads')
    .select('origem_id, valor_estimado, status')
    .eq('company_id', companyId)
    .eq('status', 'ativo')
  if (pipelineId) q = q.eq('pipeline_id', pipelineId)
  const { data, error } = await q
  if (error) throw error
  const agg = {}
  ;(data || []).forEach((r) => {
    const k = r.origem_id != null ? r.origem_id : 'sem_origem'
    if (!agg[k]) agg[k] = { origem_id: r.origem_id, total_leads: 0, valor_potencial: 0 }
    agg[k].total_leads += 1
    if (r.valor_estimado != null) agg[k].valor_potencial += Number(r.valor_estimado)
  })
  const oids = Object.values(agg).map((x) => x.origem_id).filter(Boolean)
  const omap = await repo.fetchOrigemMap(companyId, oids)
  const lista = Object.values(agg).map((row) => ({
    ...row,
    origem: row.origem_id ? omap[row.origem_id] || { id: row.origem_id, nome: '—' } : { id: null, nome: 'Sem origem' },
  }))
  lista.sort((a, b) => b.total_leads - a.total_leads)
  return { pipeline_id: pipelineId, ranking: lista }
}

async function getDashboardExtended(companyId, query) {
  const base = await getDashboard(companyId, query)
  let pipelineId = base.pipeline_id
  if (!pipelineId || !Number.isFinite(pipelineId)) {
    const p = await repo.getDefaultPipeline(companyId)
    pipelineId = p?.id ?? null
  }

  let sumGanho = 0
  if (pipelineId) {
    const { data: won, error: e1 } = await supabase
      .from('crm_leads')
      .select('valor_estimado')
      .eq('company_id', companyId)
      .eq('pipeline_id', pipelineId)
      .eq('status', 'ganho')
    if (e1) throw e1
    ;(won || []).forEach((r) => {
      if (r.valor_estimado != null) sumGanho += Number(r.valor_estimado)
    })
  } else {
    const { data: won, error: e1 } = await supabase
      .from('crm_leads')
      .select('valor_estimado')
      .eq('company_id', companyId)
      .eq('status', 'ganho')
    if (e1) throw e1
    ;(won || []).forEach((r) => {
      if (r.valor_estimado != null) sumGanho += Number(r.valor_estimado)
    })
  }

  const ganhos = base.totais.ganhos
  const perdidos = base.totais.perdidos
  const taxa = ganhos + perdidos > 0 ? ganhos / (ganhos + perdidos) : null

  const semContato = await repo.countLeads(companyId, {
    ...(pipelineId ? { pipeline_id: pipelineId } : {}),
    status: 'ativo',
    sem_contato_dias: Number(query.sem_contato_dias || 7) || 7,
  })

  const pend = await repo.countAtividadesByStatus(companyId, { status: 'pendente', pipeline_id: pipelineId })

  return {
    ...base,
    valor_ganho_estimado: sumGanho,
    taxa_conversao_ganho_vs_perdido: taxa,
    leads_sem_contato: semContato,
    atividades_pendentes: pend,
  }
}

async function deleteAtividadeFull(companyId, userId, activityId) {
  const a = await repo.getAtividadeById(companyId, activityId)
  if (!a) throw Object.assign(new Error('Atividade não encontrada'), { status: 404 })
  await removeActivityFromGoogle(companyId, userId, a)
  await repo.deleteAtividade(companyId, activityId)
  await registrar({
    company_id: companyId,
    usuario_id: userId,
    acao: 'crm_atividade_excluir',
    entidade: 'crm_atividade',
    entidade_id: activityId,
    detalhes_json: { lead_id: a.lead_id },
  })
  return { ok: true, lead_id: a.lead_id }
}

async function patchActivityStatus(companyId, userId, activityId, status, opts = {}) {
  const existing = await repo.getAtividadeById(companyId, activityId)
  if (!existing) throw Object.assign(new Error('Atividade não encontrada'), { status: 404 })
  const st = String(status)
  if (st === 'cancelada') {
    await removeActivityFromGoogle(companyId, userId, existing)
  }
  const patch = { status: st }
  if (st === 'concluida' && !existing.data_conclusao) {
    patch.data_conclusao = new Date().toISOString()
  }
  if (st === 'cancelada') {
    patch.google_event_id = null
    patch.google_html_link = null
  }
  const row = await repo.updateAtividade(companyId, activityId, patch)
  if (st === 'concluida') {
    await registrar({
      company_id: companyId,
      usuario_id: userId,
      acao: 'crm_atividade_concluir',
      entidade: 'crm_atividade',
      entidade_id: activityId,
      detalhes_json: {},
    })
  }
  const lead = await repo.getLeadById(companyId, existing.lead_id)
  if (opts.sync_google && row.data_agendada && lead && st !== 'cancelada') {
    try {
      await syncActivityToGoogle(companyId, userId, row, lead)
    } catch (_) {}
  }
  return row
}

async function assertStageTerminalUniqueness(companyId, pipelineId, tipoFechamento, exceptStageId) {
  if (!tipoFechamento || (tipoFechamento !== 'ganho' && tipoFechamento !== 'perdido')) return
  const stages = await repo.listStages(companyId, { pipeline_id: pipelineId })
  const other = stages.find(
    (s) => s.tipo_fechamento === tipoFechamento && s.id !== exceptStageId
  )
  if (other) {
    throw Object.assign(
      new Error(`Já existe estágio "${tipoFechamento}" neste pipeline (id ${other.id})`),
      { status: 409 }
    )
  }
}

async function setStageInicial(companyId, pipelineId, stageId) {
  await repo.clearInicialExcept(companyId, pipelineId, stageId)
  await repo.updateStage(companyId, stageId, { inicial: true })
}

async function clonePipeline(companyId, userId, pipelineId, nomeNovo) {
  const src = await repo.getPipelineById(companyId, pipelineId)
  if (!src) throw Object.assign(new Error('Pipeline não encontrado'), { status: 404 })
  const novo = await repo.insertPipeline({
    company_id: companyId,
    nome: nomeNovo || `${src.nome} (cópia)`,
    descricao: src.descricao,
    cor: src.cor,
    ativo: true,
    ordem: (src.ordem || 0) + 1,
    padrao: false,
  })
  const stages = await repo.listStages(companyId, { pipeline_id: pipelineId })
  for (const s of stages) {
    await repo.insertStage({
      company_id: companyId,
      pipeline_id: novo.id,
      nome: s.nome,
      descricao: s.descricao,
      cor: s.cor,
      ordem: s.ordem,
      tipo_fechamento: s.tipo_fechamento,
      exige_motivo_perda: s.exige_motivo_perda,
      ativo: s.ativo,
      inicial: false,
    })
  }
  const staged = await repo.listStages(companyId, { pipeline_id: novo.id, ativo: true })
  const firstOpen = staged.find((x) => x.tipo_fechamento == null && x.ativo)
  if (firstOpen) await setStageInicial(companyId, novo.id, firstOpen.id)
  await registrar({
    company_id: companyId,
    usuario_id: userId,
    acao: 'crm_pipeline_clonar',
    entidade: 'crm_pipeline',
    entidade_id: novo.id,
    detalhes_json: { de: pipelineId },
  })
  const ordered = await repo.listStages(companyId, { pipeline_id: novo.id })
  return { ...novo, stages: ordered }
}

async function setPipelinePadrao(companyId, pipelineId) {
  const p = await repo.getPipelineById(companyId, pipelineId)
  if (!p) throw Object.assign(new Error('Pipeline não encontrado'), { status: 404 })
  await repo.clearPadraoExcept(companyId, pipelineId)
  await repo.updatePipeline(companyId, pipelineId, { padrao: true })
  return repo.getPipelineById(companyId, pipelineId)
}

async function getPipelineComStages(companyId, pipelineId) {
  const p = await repo.getPipelineById(companyId, pipelineId)
  if (!p) return null
  const stages = await repo.listStages(companyId, { pipeline_id: pipelineId })
  return { ...p, stages }
}

async function fetchUltimaMensagemIso(companyId, conversaId) {
  const { data: um } = await supabase
    .from('mensagens')
    .select('criado_em')
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  return um?.criado_em || null
}

async function fetchMensagensParaResumo(companyId, conversaId, limit = 28) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('texto, criado_em, direcao, tipo')
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .order('criado_em', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).slice().reverse()
}

function buildHistoricoResumoNota(mensagens, maxLen = 7800) {
  const lines = [
    '— Resumo automático do histórico (últimas mensagens) —',
    '',
  ]
  for (const m of mensagens) {
    const quem = String(m.direcao) === 'in' ? 'Cliente' : 'Equipe'
    const tRaw = String(m.tipo || 'texto').toLowerCase()
    let content = String(m.texto || '').trim()
    if (tRaw && tRaw !== 'texto') {
      const label = tRaw.replace(/_/g, ' ')
      content = content ? `[${label}] ${content}` : `[${label}]`
    }
    if (!content) continue
    let ts = ''
    try {
      if (m.criado_em) {
        ts = new Date(m.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      }
    } catch (_) {}
    lines.push(ts ? `[${ts}] ${quem}: ${content}` : `${quem}: ${content}`)
  }
  let out = lines.join('\n')
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 40)}\n… (texto truncado)`
  return out
}

function buildObservacaoImportBloqueio({
  conv,
  deptNome,
  importadoPorNome,
  conversaId,
}) {
  const lines = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Importado do ZapERP · Atendimento',
    `Conversa #${conversaId}`,
  ]
  if (conv.telefone) lines.push(`Telefone: ${conv.telefone}`)
  if (deptNome) lines.push(`Setor: ${deptNome}`)
  lines.push(`Status do ticket: ${conv.status_atendimento || '—'}`)
  lines.push(`Tipo: ${conv.tipo || 'cliente'}`)
  if (importadoPorNome) lines.push(`Enviado ao CRM por: ${importadoPorNome}`)
  lines.push(`Registrado em: ${new Date().toISOString()}`)
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (conv.observacao && String(conv.observacao).trim()) {
    lines.push('')
    lines.push('Observações do atendimento (campo da conversa):')
    lines.push(String(conv.observacao).trim())
  }
  return lines.join('\n')
}

function mergeObservacoes(importBlock, extra) {
  const e = extra != null && String(extra).trim() ? String(extra).trim() : ''
  if (!e) return importBlock
  return `${importBlock}\n\n— Nota do atendente ao enviar ao CRM —\n${e}`
}

function resolveNomeLead({ conv, cli, body }) {
  if (body.nome && String(body.nome).trim()) return String(body.nome).trim()
  if (cli?.nome && String(cli.nome).trim()) return String(cli.nome).trim()
  if (conv.tipo === 'grupo' && conv.nome_grupo && String(conv.nome_grupo).trim()) {
    return String(conv.nome_grupo).trim()
  }
  if (conv.nome_contato_cache && String(conv.nome_contato_cache).trim()) {
    return String(conv.nome_contato_cache).trim()
  }
  if (conv.telefone) return String(conv.telefone)
  return `Conversa #${conv.id}`
}

/**
 * Envia conversa ao CRM: preenche dados do cliente/conversa, tags da conversa, observações
 * estruturadas e nota com resumo do histórico (opcional).
 * @returns {{ httpStatus: number, body: object }}
 */
async function createLeadFromConversa(companyId, userId, conversaId, body = {}) {
  const { data: conv, error: eConv } = await supabase
    .from('conversas')
    .select(
      'id, cliente_id, telefone, company_id, departamento_id, status_atendimento, atendente_id, tipo, nome_grupo, nome_contato_cache, observacao'
    )
    .eq('company_id', companyId)
    .eq('id', conversaId)
    .maybeSingle()
  if (eConv) throw eConv
  if (!conv) throw Object.assign(new Error('Conversa não encontrada'), { status: 404 })

  let deptNome = null
  if (conv.departamento_id) {
    const { data: dep } = await supabase
      .from('departamentos')
      .select('nome')
      .eq('company_id', companyId)
      .eq('id', conv.departamento_id)
      .maybeSingle()
    deptNome = dep?.nome ?? null
  }

  const { data: importador } = await supabase
    .from('usuarios')
    .select('nome')
    .eq('company_id', companyId)
    .eq('id', userId)
    .maybeSingle()
  const importadoPorNome = importador?.nome || null

  let cli = null
  if (conv.cliente_id) {
    const { data: c } = await supabase
      .from('clientes')
      .select('id, nome, empresa, telefone, email')
      .eq('company_id', companyId)
      .eq('id', conv.cliente_id)
      .maybeSingle()
    cli = c || null
  }

  const conversaTagIds = await repo.listConversaTagIds(companyId, conversaId)
  const bodyTagIds = Array.isArray(body.tag_ids) ? body.tag_ids : []
  const mergedTagIds = [...new Set([...conversaTagIds, ...bodyTagIds].map(Number).filter((x) => Number.isFinite(x) && x > 0))]

  const vincularTags = body.vincular_tags_da_conversa !== false
  const tagIdsParaLead = vincularTags ? mergedTagIds : [...new Set(bodyTagIds.map(Number).filter((x) => Number.isFinite(x) && x > 0))]

  const existing = await repo.findLeadByConversaId(companyId, conversaId)
  if (existing) {
    if (body.sincronizar_duplicata === false) {
      const detail = await getLeadDetailEnriched(companyId, existing.id)
      return {
        httpStatus: 409,
        body: {
          error: 'Já existe um lead vinculado a esta conversa.',
          lead: detail,
          from_conversa: {
            duplicate: true,
            conversa_id: conversaId,
            sincronizado: false,
          },
        },
      }
    }

    const ultima = await fetchUltimaMensagemIso(companyId, conversaId)
    const patch = {}
    if (ultima) patch.ultima_interacao_em = ultima
    if (body.atualizar_responsavel_em_duplicata === true && body.responsavel_id !== undefined) {
      patch.responsavel_id = body.responsavel_id != null ? Number(body.responsavel_id) : null
    }
    if (Object.keys(patch).length) await repo.updateLead(companyId, existing.id, patch)

    if (vincularTags) {
      const leadIds = await repo.listLeadTagIds(companyId, existing.id)
      const merged = [...new Set([...leadIds, ...conversaTagIds, ...bodyTagIds].map(Number).filter((x) => Number.isFinite(x) && x > 0))]
      await repo.replaceLeadTags(companyId, existing.id, merged)
    } else if (bodyTagIds.length) {
      const only = [...new Set(bodyTagIds.map(Number).filter((x) => Number.isFinite(x) && x > 0))]
      await repo.replaceLeadTags(companyId, existing.id, only)
    }

    const detail = await getLeadDetailEnriched(companyId, existing.id)
    return {
      httpStatus: 200,
      body: {
        lead: detail,
        from_conversa: {
          created: false,
          duplicate: true,
          conversa_id: conversaId,
          sincronizado: true,
          tags_mescladas: vincularTags ? (conversaTagIds?.length ?? 0) : 0,
        },
      },
    }
  }

  let nome = resolveNomeLead({ conv, cli, body })
  let empresa = body.empresa !== undefined ? body.empresa : cli?.empresa ?? null
  let telefone = body.telefone != null ? String(body.telefone) : conv.telefone
  if (cli?.telefone && !telefone) telefone = cli.telefone
  const email = body.email !== undefined ? body.email : cli?.email ?? null

  const importBlock = buildObservacaoImportBloqueio({
    conv,
    deptNome,
    importadoPorNome,
    conversaId,
  })
  let observacoes = mergeObservacoes(importBlock, body.observacoes)
  if (observacoes.length > 20000) {
    observacoes = `${observacoes.slice(0, 19950)}\n… (observações truncadas)`
  }

  const ultima = await fetchUltimaMensagemIso(companyId, conversaId)

  const payload = {
    nome,
    empresa: empresa != null ? empresa : null,
    telefone: telefone != null ? String(telefone) : null,
    email: email != null ? String(email).trim() : null,
    conversa_id: conversaId,
    cliente_id: conv.cliente_id || null,
    pipeline_id: body.pipeline_id,
    stage_id: body.stage_id,
    origem_id: body.origem_id,
    responsavel_id: body.responsavel_id !== undefined ? body.responsavel_id : userId,
    prioridade: body.prioridade,
    valor_estimado: body.valor_estimado,
    probabilidade: body.probabilidade,
    observacoes,
    tag_ids: tagIdsParaLead,
    vincular_cliente_por_telefone: false,
  }

  const created = await createLead(companyId, userId, payload, true)
  if (ultima) {
    await repo.updateLead(companyId, created.id, { ultima_interacao_em: ultima })
  }

  let notaResumoId = null
  const querNota = body.criar_nota_com_resumo !== false
  if (querNota) {
    const msgs = await fetchMensagensParaResumo(companyId, conversaId, 30)
    if (msgs.length) {
      const textoNota = buildHistoricoResumoNota(msgs)
      const notaRow = await repo.insertNota({
        company_id: companyId,
        lead_id: created.id,
        texto: textoNota,
        criado_por: userId,
      })
      notaResumoId = notaRow?.id ?? null
    }
  }

  const detail = await getLeadDetailEnriched(companyId, created.id)
  return {
    httpStatus: 201,
    body: {
      lead: detail,
      from_conversa: {
        created: true,
        duplicate: false,
        conversa_id: conversaId,
        tags_sincronizadas: vincularTags ? conversaTagIds.length : 0,
        nota_resumo_criada: !!notaResumoId,
        nota_resumo_id: notaResumoId,
      },
    },
  }
}

async function createLeadFromCliente(companyId, userId, clienteId, body = {}) {
  const { data: cli, error } = await supabase
    .from('clientes')
    .select('id, nome, empresa, telefone, email')
    .eq('company_id', companyId)
    .eq('id', clienteId)
    .maybeSingle()
  if (error) throw error
  if (!cli) throw Object.assign(new Error('Cliente não encontrado'), { status: 404 })
  const payload = {
    nome: body.nome || cli.nome || cli.telefone || `Cliente #${clienteId}`,
    empresa: body.empresa !== undefined ? body.empresa : cli.empresa,
    telefone: body.telefone != null ? body.telefone : cli.telefone,
    email: body.email !== undefined ? body.email : cli.email,
    cliente_id: clienteId,
    pipeline_id: body.pipeline_id,
    stage_id: body.stage_id,
    origem_id: body.origem_id,
    responsavel_id: body.responsavel_id !== undefined ? body.responsavel_id : userId,
    vincular_cliente_por_telefone: false,
  }
  return createLead(companyId, userId, payload, true)
}

module.exports = {
  ensureDefaultCrmSetup,
  createLead,
  updateLead,
  moveLead,
  reorderLeads,
  getKanban,
  getDashboard,
  getDashboardExtended,
  getDashboardFunnel,
  getDashboardResponsaveis,
  getDashboardOrigens,
  getColumnTotalsForPipeline,
  listLeadsEnriched,
  getLeadDetailEnriched,
  getAgendaComercial,
  getAgendaResumo,
  syncActivityToGoogle,
  syncLeadToGoogle,
  removeActivityFromGoogle,
  deleteAtividadeFull,
  patchActivityStatus,
  assertStageTerminalUniqueness,
  setStageInicial,
  clonePipeline,
  setPipelinePadrao,
  getPipelineComStages,
  createLeadFromConversa,
  createLeadFromCliente,
  terminalPatchFromStage,
  tryResolveClienteFromTelefone,
  enrichLeadRows,
  buildActivityGoogleDescription,
}
