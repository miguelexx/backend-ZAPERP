/**
 * Acesso a dados CRM — sempre filtrar por company_id (camada única de queries).
 */
const supabase = require('../config/supabase')

function asInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchUsuarioMap(companyId, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (ids.length === 0) return {}
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, email')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw error
  const map = {}
  ;(data || []).forEach((u) => { map[u.id] = u })
  return map
}

async function fetchTagsForLeads(companyId, leadIds) {
  if (!leadIds.length) return { byLead: {}, tagMeta: {} }
  const { data: rows, error } = await supabase
    .from('crm_lead_tags')
    .select('lead_id, tag_id')
    .eq('company_id', companyId)
    .in('lead_id', leadIds)
  if (error) throw error
  const tagIds = [...new Set((rows || []).map((r) => r.tag_id).filter(Boolean))]
  let tagMeta = {}
  if (tagIds.length) {
    const { data: tags, error: te } = await supabase
      .from('tags')
      .select('id, nome, cor')
      .eq('company_id', companyId)
      .in('id', tagIds)
    if (te) throw te
    ;(tags || []).forEach((t) => { tagMeta[t.id] = t })
  }
  const byLead = {}
  ;(rows || []).forEach((r) => {
    if (!byLead[r.lead_id]) byLead[r.lead_id] = []
    const t = tagMeta[r.tag_id]
    if (t) byLead[r.lead_id].push({ id: t.id, nome: t.nome, cor: t.cor })
  })
  return { byLead, tagMeta }
}

// ---------- Pipelines ----------
async function listPipelines(companyId, { ativo } = {}) {
  let q = supabase
    .from('crm_pipelines')
    .select('*')
    .eq('company_id', companyId)
    .order('ordem', { ascending: true })
    .order('id', { ascending: true })
  if (ativo === true) q = q.eq('ativo', true)
  if (ativo === false) q = q.eq('ativo', false)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function getPipelineById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_pipelines')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function insertPipeline(row) {
  const { data, error } = await supabase.from('crm_pipelines').insert(row).select().single()
  if (error) throw error
  return data
}

async function updatePipeline(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_pipelines')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function deletePipeline(companyId, id) {
  const { error } = await supabase
    .from('crm_pipelines')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
  if (error) throw error
}

// ---------- Stages ----------
async function listStages(companyId, { pipeline_id, ativo } = {}) {
  let q = supabase
    .from('crm_stages')
    .select('*')
    .eq('company_id', companyId)
    .order('ordem', { ascending: true })
    .order('id', { ascending: true })
  if (pipeline_id != null) q = q.eq('pipeline_id', asInt(pipeline_id))
  if (ativo === true) q = q.eq('ativo', true)
  if (ativo === false) q = q.eq('ativo', false)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function getStageById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_stages')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function insertStage(row) {
  const { data, error } = await supabase.from('crm_stages').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateStage(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_stages')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function deleteStage(companyId, id) {
  const { error } = await supabase
    .from('crm_stages')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
  if (error) throw error
}

async function getFirstOpenStage(companyId, pipelineId) {
  const { data: marked, error: e1 } = await supabase
    .from('crm_stages')
    .select('*')
    .eq('company_id', companyId)
    .eq('pipeline_id', pipelineId)
    .eq('ativo', true)
    .eq('inicial', true)
    .is('tipo_fechamento', null)
    .maybeSingle()
  if (e1) throw e1
  if (marked) return marked

  const { data, error } = await supabase
    .from('crm_stages')
    .select('*')
    .eq('company_id', companyId)
    .eq('pipeline_id', pipelineId)
    .eq('ativo', true)
    .is('tipo_fechamento', null)
    .order('ordem', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------- Origens ----------
async function listOrigens(companyId, { ativo } = {}) {
  let q = supabase
    .from('crm_origens')
    .select('*')
    .eq('company_id', companyId)
    .order('nome', { ascending: true })
  if (ativo === true) q = q.eq('ativo', true)
  if (ativo === false) q = q.eq('ativo', false)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function getOrigemById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_origens')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function insertOrigem(row) {
  const { data, error } = await supabase.from('crm_origens').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateOrigem(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_origens')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------- Leads ----------
function buildLeadFilters(q, query) {
  let qb = q
  const {
    pipeline_id,
    stage_id,
    responsavel_id,
    status,
    origem_id,
    prioridade,
    sem_contato_dias,
    proximo_contato_de,
    proximo_contato_ate,
    criado_de,
    criado_ate,
    q: texto,
  } = query || {}

  if (pipeline_id != null && pipeline_id !== '') qb = qb.eq('pipeline_id', asInt(pipeline_id))
  if (stage_id != null && stage_id !== '') qb = qb.eq('stage_id', asInt(stage_id))
  if (responsavel_id != null && responsavel_id !== '') {
    if (String(responsavel_id) === 'null' || String(responsavel_id) === 'none') {
      qb = qb.is('responsavel_id', null)
    } else {
      qb = qb.eq('responsavel_id', asInt(responsavel_id))
    }
  }
  if (status) qb = qb.eq('status', String(status))
  if (origem_id != null && origem_id !== '') qb = qb.eq('origem_id', asInt(origem_id))
  if (prioridade) qb = qb.eq('prioridade', String(prioridade))

  const dias = sem_contato_dias != null && sem_contato_dias !== '' ? asInt(sem_contato_dias) : null
  if (dias != null && dias > 0) {
    const limit = new Date(Date.now() - dias * 86400000).toISOString()
    qb = qb.or(`ultima_interacao_em.is.null,ultima_interacao_em.lt."${limit}"`)
  }

  if (proximo_contato_de) qb = qb.gte('data_proximo_contato', String(proximo_contato_de))
  if (proximo_contato_ate) qb = qb.lte('data_proximo_contato', String(proximo_contato_ate))

  const proximoVencido = query?.proximo_vencido === true || query?.proximo_vencido === 'true' || query?.proximo_vencido === '1'
  if (proximoVencido) {
    qb = qb.lt('data_proximo_contato', new Date().toISOString())
    qb = qb.eq('status', 'ativo')
  }

  if (criado_de) qb = qb.gte('criado_em', String(criado_de))
  if (criado_ate) qb = qb.lte('criado_em', String(criado_ate))

  if (texto && String(texto).trim()) {
    const raw = String(texto).trim().replace(/"/g, '').replace(/,/g, ' ')
    const t = `%${raw}%`
    qb = qb.or(`nome.ilike.${t},empresa.ilike.${t},telefone.ilike.${t},email.ilike.${t}`)
  }
  return qb
}

async function countLeads(companyId, query) {
  let q = supabase
    .from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  q = buildLeadFilters(q, query)
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

async function listLeads(companyId, query) {
  const page = Math.max(asInt(query.page) || 1, 1)
  const pageSize = Math.min(Math.max(asInt(query.page_size) || 20, 1), 200)
  const offset = (page - 1) * pageSize

  const sort = String(query.sort || 'atualizado_em').toLowerCase()
  const dir = String(query.dir || 'desc').toLowerCase() === 'asc'
  const sortCol = ['nome', 'valor_estimado', 'criado_em', 'atualizado_em', 'ultima_interacao_em', 'data_proximo_contato'].includes(sort)
    ? sort
    : 'atualizado_em'

  let q = supabase
    .from('crm_leads')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
  q = buildLeadFilters(q, query)
  q = q.order(sortCol, { ascending: dir })
  q = q.range(offset, offset + pageSize - 1)

  const { data, error, count } = await q
  if (error) throw error
  const leads = data || []
  const leadIds = leads.map((l) => l.id)
  const { byLead } = await fetchTagsForLeads(companyId, leadIds)
  const userMap = await fetchUsuarioMap(companyId, leads.map((l) => l.responsavel_id).filter(Boolean))

  const items = leads.map((l) => ({
    ...l,
    tags: byLead[l.id] || [],
    responsavel: l.responsavel_id ? userMap[l.responsavel_id] || { id: l.responsavel_id, nome: null } : null,
  }))

  return {
    items,
    page,
    page_size: pageSize,
    total: count ?? items.length,
  }
}

async function getLeadById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function insertLead(row) {
  const { data, error } = await supabase.from('crm_leads').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateLead(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_leads')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function listLeadsByPipeline(companyId, pipelineId) {
  const { data, error } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('company_id', companyId)
    .eq('pipeline_id', pipelineId)
  if (error) throw error
  return data || []
}

async function listLeadsByStage(companyId, stageId) {
  const { data, error } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('company_id', companyId)
    .eq('stage_id', stageId)
    .order('ordem', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return data || []
}

async function maxOrdemInStage(companyId, stageId) {
  const { data, error } = await supabase
    .from('crm_leads')
    .select('ordem')
    .eq('company_id', companyId)
    .eq('stage_id', stageId)
    .order('ordem', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.ordem != null ? Number(data.ordem) : -1
}

async function countLeadsByStages(companyId, stageIds) {
  if (!stageIds.length) return {}
  const { data, error } = await supabase
    .from('crm_leads')
    .select('stage_id')
    .eq('company_id', companyId)
    .in('stage_id', stageIds)
  if (error) throw error
  const counts = {}
  stageIds.forEach((sid) => { counts[sid] = 0 })
  ;(data || []).forEach((r) => {
    const s = r.stage_id
    counts[s] = (counts[s] || 0) + 1
  })
  return counts
}

// ---------- Tags no lead ----------
async function replaceLeadTags(companyId, leadId, tagIds) {
  await supabase.from('crm_lead_tags').delete().eq('company_id', companyId).eq('lead_id', leadId)
  if (!tagIds.length) return
  const rows = tagIds.map((tid) => ({
    company_id: companyId,
    lead_id: leadId,
    tag_id: tid,
  }))
  const { error } = await supabase.from('crm_lead_tags').insert(rows)
  if (error) throw error
}

async function addLeadTag(companyId, leadId, tagId) {
  const { error } = await supabase.from('crm_lead_tags').insert({
    company_id: companyId,
    lead_id: leadId,
    tag_id: tagId,
  })
  if (error) throw error
}

async function removeLeadTag(companyId, leadId, tagId) {
  const { error } = await supabase
    .from('crm_lead_tags')
    .delete()
    .eq('company_id', companyId)
    .eq('lead_id', leadId)
    .eq('tag_id', tagId)
  if (error) throw error
}

// ---------- Notas ----------
async function listNotas(companyId, leadId) {
  const { data, error } = await supabase
    .from('crm_notas')
    .select('*')
    .eq('company_id', companyId)
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
  if (error) throw error
  return data || []
}

async function insertNota(row) {
  const { data, error } = await supabase.from('crm_notas').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateNota(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_notas')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function deleteNota(companyId, id) {
  const { error } = await supabase.from('crm_notas').delete().eq('company_id', companyId).eq('id', id)
  if (error) throw error
}

async function getNotaById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_notas')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------- Atividades ----------
async function listAtividades(companyId, leadId) {
  const { data, error } = await supabase
    .from('crm_atividades')
    .select('*')
    .eq('company_id', companyId)
    .eq('lead_id', leadId)
    .order('data_agendada', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data || []
}

async function listAtividadesAgenda(companyId, { de, ate, responsavel_id, status, tipo }) {
  let q = supabase
    .from('crm_atividades')
    .select('*')
    .eq('company_id', companyId)
    .not('data_agendada', 'is', null)
    .gte('data_agendada', de)
    .lte('data_agendada', ate)
    .order('data_agendada', { ascending: true })
  if (responsavel_id) q = q.eq('responsavel_id', asInt(responsavel_id))
  if (status) q = q.eq('status', String(status))
  if (tipo) q = q.eq('tipo', String(tipo))
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function listProximosContatosAgenda(companyId, { de, ate, responsavel_id }) {
  let q = supabase
    .from('crm_leads')
    .select('id, nome, empresa, data_proximo_contato, responsavel_id, pipeline_id, stage_id, status')
    .eq('company_id', companyId)
    .eq('status', 'ativo')
    .not('data_proximo_contato', 'is', null)
    .gte('data_proximo_contato', de)
    .lte('data_proximo_contato', ate)
    .order('data_proximo_contato', { ascending: true })
  if (responsavel_id) q = q.eq('responsavel_id', asInt(responsavel_id))
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function countNotasByLeadIds(companyId, leadIds) {
  if (!leadIds.length) return {}
  const { data, error } = await supabase
    .from('crm_notas')
    .select('lead_id')
    .eq('company_id', companyId)
    .in('lead_id', leadIds)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((r) => {
    m[r.lead_id] = (m[r.lead_id] || 0) + 1
  })
  return m
}

async function countAtividadesByLeadIds(companyId, leadIds) {
  if (!leadIds.length) return {}
  const { data, error } = await supabase
    .from('crm_atividades')
    .select('lead_id')
    .eq('company_id', companyId)
    .in('lead_id', leadIds)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((r) => {
    m[r.lead_id] = (m[r.lead_id] || 0) + 1
  })
  return m
}

async function fetchProximaAtividadePendenteByLeadIds(companyId, leadIds) {
  if (!leadIds.length) return {}
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('crm_atividades')
    .select('id, lead_id, titulo, tipo, data_agendada, status')
    .eq('company_id', companyId)
    .eq('status', 'pendente')
    .in('lead_id', leadIds)
    .not('data_agendada', 'is', null)
    .gte('data_agendada', now)
    .order('data_agendada', { ascending: true })
  if (error) throw error
  const m = {}
  ;(data || []).forEach((r) => {
    if (m[r.lead_id] == null) m[r.lead_id] = r
  })
  return m
}

async function getDefaultPipeline(companyId) {
  const { data, error } = await supabase
    .from('crm_pipelines')
    .select('*')
    .eq('company_id', companyId)
    .eq('padrao', true)
    .eq('ativo', true)
    .maybeSingle()
  if (error) throw error
  if (data) return data
  const pipes = await listPipelines(companyId, { ativo: true })
  return pipes[0] || null
}

async function clearPadraoExcept(companyId, pipelineId) {
  await supabase
    .from('crm_pipelines')
    .update({ padrao: false, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .neq('id', pipelineId)
}

async function clearInicialExcept(companyId, pipelineId, stageId) {
  await supabase
    .from('crm_stages')
    .update({ inicial: false, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('pipeline_id', pipelineId)
    .neq('id', stageId)
}

async function deleteAtividade(companyId, id) {
  const { error } = await supabase
    .from('crm_atividades')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
  if (error) throw error
}

async function countAtividadesByStatus(companyId, { status, pipeline_id }) {
  let q = supabase
    .from('crm_atividades')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (status) q = q.eq('status', String(status))
  if (pipeline_id) {
    const { data: leads, error: e1 } = await supabase
      .from('crm_leads')
      .select('id')
      .eq('company_id', companyId)
      .eq('pipeline_id', asInt(pipeline_id))
    if (e1) throw e1
    const lids = (leads || []).map((l) => l.id)
    if (!lids.length) return 0
    q = q.in('lead_id', lids)
  }
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

async function getAtividadeById(companyId, id) {
  const { data, error } = await supabase
    .from('crm_atividades')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function insertAtividade(row) {
  const { data, error } = await supabase.from('crm_atividades').insert(row).select().single()
  if (error) throw error
  return data
}

async function updateAtividade(companyId, id, patch) {
  const { data, error } = await supabase
    .from('crm_atividades')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

// ---------- Movimentos ----------
async function insertMovement(row) {
  const { data, error } = await supabase.from('crm_stage_movements').insert(row).select().single()
  if (error) throw error
  return data
}

async function listMovements(companyId, leadId, { limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('crm_stage_movements')
    .select('*')
    .eq('company_id', companyId)
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(Math.min(limit, 500))
  if (error) throw error
  return data || []
}

// ---------- Google tokens ----------
async function getGoogleTokens(companyId, usuarioId) {
  const { data, error } = await supabase
    .from('crm_google_tokens')
    .select('*')
    .eq('company_id', companyId)
    .eq('usuario_id', usuarioId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function upsertGoogleTokens(row) {
  const { data, error } = await supabase
    .from('crm_google_tokens')
    .upsert([row], { onConflict: 'company_id,usuario_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

async function updateGoogleTokens(companyId, usuarioId, patch) {
  const { data, error } = await supabase
    .from('crm_google_tokens')
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('usuario_id', usuarioId)
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

async function deleteGoogleTokens(companyId, usuarioId) {
  const { error } = await supabase
    .from('crm_google_tokens')
    .delete()
    .eq('company_id', companyId)
    .eq('usuario_id', usuarioId)
  if (error) throw error
}

async function insertGoogleLog(row) {
  const { error } = await supabase.from('crm_webhook_logs_google').insert(row)
  if (error) throw error
}

// ---------- Lost reasons ----------
async function listLostReasons(companyId) {
  const { data, error } = await supabase
    .from('crm_lost_reasons')
    .select('*')
    .eq('company_id', companyId)
    .eq('ativo', true)
    .order('ordem', { ascending: true })
  if (error) throw error
  return data || []
}

async function fetchPipelineMap(companyId, ids) {
  const u = [...new Set((ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (!u.length) return {}
  const { data, error } = await supabase
    .from('crm_pipelines')
    .select('id, nome, cor, ordem, padrao, ativo')
    .eq('company_id', companyId)
    .in('id', u)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((p) => { m[p.id] = p })
  return m
}

async function fetchStageMap(companyId, ids) {
  const u = [...new Set((ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (!u.length) return {}
  const { data, error } = await supabase
    .from('crm_stages')
    .select('id, nome, cor, ordem, pipeline_id, tipo_fechamento, inicial, ativo')
    .eq('company_id', companyId)
    .in('id', u)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((s) => { m[s.id] = s })
  return m
}

async function fetchOrigemMap(companyId, ids) {
  const u = [...new Set((ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (!u.length) return {}
  const { data, error } = await supabase
    .from('crm_origens')
    .select('id, nome, cor')
    .eq('company_id', companyId)
    .in('id', u)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((o) => { m[o.id] = o })
  return m
}

async function fetchClienteMap(companyId, ids) {
  const u = [...new Set((ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (!u.length) return {}
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome, telefone, email, empresa')
    .eq('company_id', companyId)
    .in('id', u)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((c) => { m[c.id] = c })
  return m
}

async function fetchConversaMap(companyId, ids) {
  const u = [...new Set((ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))]
  if (!u.length) return {}
  const { data, error } = await supabase
    .from('conversas')
    .select('id, telefone, nome_grupo, ultima_atividade, status_atendimento')
    .eq('company_id', companyId)
    .in('id', u)
  if (error) throw error
  const m = {}
  ;(data || []).forEach((c) => { m[c.id] = c })
  return m
}

async function listLeadsForExport(companyId, query, maxRows) {
  const cap = Math.min(Math.max(asInt(maxRows) || 5000, 1), 10000)
  let q = supabase
    .from('crm_leads')
    .select('*')
    .eq('company_id', companyId)
  q = buildLeadFilters(q, query)
  q = q.order('id', { ascending: false })
  q = q.limit(cap)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

module.exports = {
  listPipelines,
  getPipelineById,
  insertPipeline,
  updatePipeline,
  deletePipeline,
  listStages,
  getStageById,
  insertStage,
  updateStage,
  deleteStage,
  getFirstOpenStage,
  listOrigens,
  getOrigemById,
  insertOrigem,
  updateOrigem,
  listLeads,
  countLeads,
  getLeadById,
  insertLead,
  updateLead,
  listLeadsByPipeline,
  listLeadsByStage,
  maxOrdemInStage,
  countLeadsByStages,
  replaceLeadTags,
  addLeadTag,
  removeLeadTag,
  fetchTagsForLeads,
  fetchUsuarioMap,
  listNotas,
  insertNota,
  updateNota,
  deleteNota,
  getNotaById,
  listAtividades,
  listAtividadesAgenda,
  getAtividadeById,
  insertAtividade,
  updateAtividade,
  insertMovement,
  listMovements,
  getGoogleTokens,
  upsertGoogleTokens,
  updateGoogleTokens,
  deleteGoogleTokens,
  insertGoogleLog,
  listLostReasons,
  buildLeadFilters,
  listProximosContatosAgenda,
  countNotasByLeadIds,
  countAtividadesByLeadIds,
  fetchProximaAtividadePendenteByLeadIds,
  getDefaultPipeline,
  clearPadraoExcept,
  clearInicialExcept,
  deleteAtividade,
  countAtividadesByStatus,
  fetchPipelineMap,
  fetchStageMap,
  fetchOrigemMap,
  fetchClienteMap,
  fetchConversaMap,
  listLeadsForExport,
}
