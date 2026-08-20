const supabase = require('../config/supabase')
const {
  DEFAULT_CHATBOT_CONFIG,
  validateChatbotConfig,
  normalizeChatbotTriageStrings,
} = require('./chatbotTriageService')

const CLOSED_STATUSES = ['fechada', 'finalizada']

function normalizeNoSelectionRoutingConfig(chatbotConfig) {
  const raw = { ...DEFAULT_CHATBOT_CONFIG, ...(chatbotConfig || {}) }
  const normalized = validateChatbotConfig(raw) || normalizeChatbotTriageStrings(raw) || raw
  return {
    ativo: normalized.enabled === true && normalized.encaminhar_sem_escolha_ativo === true,
    minutos: Math.max(1, Math.min(1440, Math.round(Number(normalized.encaminhar_sem_escolha_minutos) || 10))),
    departamentosIds: [...new Set(
      (Array.isArray(normalized.encaminhar_sem_escolha_departamentos_ids)
        ? normalized.encaminhar_sem_escolha_departamentos_ids
        : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    )],
  }
}

function isClosedStatus(status) {
  return CLOSED_STATUSES.includes(String(status || '').trim().toLowerCase())
}

async function claimConversation({ companyId, conversation, cutoffIso, departmentIds }) {
  const { data, error } = await supabase.rpc('claim_chatbot_no_selection_route', {
    p_company_id: companyId,
    p_conversa_id: Number(conversation.id),
    p_departamento_ids: departmentIds,
    p_limite_atividade: cutoffIso,
    p_prazo_minutos: conversation.timeoutMinutes,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row?.conversa_id ? row : null
}

async function recordRoutingHistory(companyId, result, timeoutMinutes) {
  const departmentName = result.departamento_nome || `setor ${result.departamento_id}`
  const observation = `Encaminhamento automático após ${timeoutMinutes} min sem escolha: ${departmentName}`
  try {
    await Promise.all([
      supabase.from('atendimentos').insert({
        conversa_id: result.conversa_id,
        de_usuario_id: null,
        para_usuario_id: null,
        acao: 'transferiu',
        observacao: observation,
        company_id: companyId,
      }),
      supabase.from('historico_atendimentos').insert({
        conversa_id: result.conversa_id,
        usuario_id: null,
        acao: 'encaminhamento_automatico_sem_escolha',
        observacao: observation,
      }),
    ])
  } catch (error) {
    console.warn('[chatbotNoSelectionRouting] histórico:', error?.message || error)
  }
}

function emitRoutingRealtime(io, companyId, result) {
  if (!io) return
  try {
    const { emitirEventoEmpresaConversa } = require('../controllers/chatController')
    const payload = {
      id: Number(result.conversa_id),
      departamento_id: Number(result.departamento_id),
      atendente_id: null,
      status_atendimento: 'aberta',
    }
    emitirEventoEmpresaConversa(io, companyId, result.conversa_id, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
    io.to(`empresa_${Number(companyId)}`).emit(io.EVENTS?.ATUALIZAR_CONVERSA || 'atualizar_conversa', { id: Number(result.conversa_id) })
  } catch (error) {
    console.warn('[chatbotNoSelectionRouting] realtime:', error?.message || error)
  }
}

async function processCompany({ companyId, chatbotConfig, now, dryRun, io, scanLimit }) {
  const routing = normalizeNoSelectionRoutingConfig(chatbotConfig)
  if (!routing.ativo || routing.departamentosIds.length === 0) return { analisadas: 0, processadas: 0, candidatos: [] }

  const cutoffIso = new Date(now.getTime() - routing.minutos * 60_000).toISOString()
  const { data: conversations, error: conversationsError } = await supabase
    .from('conversas')
    .select('id, ultima_atividade, status_atendimento, departamento_id, atendente_id, tipo, telefone')
    .eq('company_id', companyId)
    .is('departamento_id', null)
    .is('atendente_id', null)
    .lte('ultima_atividade', cutoffIso)
    .neq('status_atendimento', 'fechada')
    .neq('status_atendimento', 'finalizada')
    .order('ultima_atividade', { ascending: true })
    .limit(scanLimit)
  if (conversationsError) throw conversationsError

  const staleConversations = (conversations || []).filter((conversation) => {
    const type = String(conversation?.tipo || '').toLowerCase()
    const phone = String(conversation?.telefone || '').toLowerCase()
    return !isClosedStatus(conversation?.status_atendimento) && type !== 'grupo' && !phone.includes('@g.us')
  })
  if (staleConversations.length === 0) return { analisadas: 0, processadas: 0, candidatos: [] }

  const staleIds = staleConversations.map((conversation) => Number(conversation.id))
  const { data: menuLogs, error: logsError } = await supabase
    .from('bot_logs')
    .select('conversa_id, criado_em')
    .eq('company_id', companyId)
    .in('conversa_id', staleIds)
    .in('tipo', ['menu_enviado', 'menu_reenviado'])
    .order('criado_em', { ascending: false })
    .limit(Math.min(2000, scanLimit * 4))
  if (logsError) throw logsError

  const latestMenuByConversation = new Map()
  ;(menuLogs || []).forEach((row) => {
    const id = Number(row?.conversa_id)
    if (id > 0 && !latestMenuByConversation.has(id)) latestMenuByConversation.set(id, row.criado_em)
  })
  const candidates = staleConversations.filter((conversation) => {
    const latestMenuAt = latestMenuByConversation.get(Number(conversation.id))
    return latestMenuAt && Date.parse(latestMenuAt) <= Date.parse(cutoffIso)
  })
  if (dryRun) {
    return {
      analisadas: candidates.length,
      processadas: 0,
      candidatos: candidates.map((c) => ({ conversa_id: Number(c.id), limite_atividade: cutoffIso })),
    }
  }

  let processed = 0
  for (const conversation of candidates) {
    try {
      const enriched = { ...conversation, timeoutMinutes: routing.minutos }
      const result = await claimConversation({
        companyId,
        conversation: enriched,
        cutoffIso,
        departmentIds: routing.departamentosIds,
      })
      if (!result) continue
      processed += 1
      await recordRoutingHistory(companyId, result, routing.minutos)
      emitRoutingRealtime(io, companyId, result)
    } catch (error) {
      console.warn('[chatbotNoSelectionRouting] conversa não encaminhada', {
        company_id: companyId,
        conversa_id: conversation.id,
        error: error?.message || error,
      })
    }
  }
  return { analisadas: candidates.length, processadas: processed, candidatos: [] }
}

async function processNoSelectionAutoRouting({ dryRun = false, io = null, now = new Date() } = {}) {
  const scanLimit = Math.max(50, Math.min(2000, Number(process.env.CHATBOT_NO_SELECTION_SCAN_LIMIT) || 500))
  const { data: configs, error } = await supabase.from('ia_config').select('company_id, config')
  if (error) return { ok: false, error: error.message, analisadas: 0, processadas: 0 }

  let analyzed = 0
  let processed = 0
  const candidates = []
  for (const row of configs || []) {
    try {
      const result = await processCompany({
        companyId: Number(row.company_id),
        chatbotConfig: row.config?.chatbot_triage,
        now,
        dryRun,
        io,
        scanLimit,
      })
      analyzed += result.analisadas
      processed += result.processadas
      candidates.push(...result.candidatos)
    } catch (companyError) {
      console.warn('[chatbotNoSelectionRouting] empresa ignorada:', row.company_id, companyError?.message || companyError)
    }
  }
  return { ok: true, analisadas: analyzed, processadas: processed, candidatos: candidates }
}

module.exports = {
  normalizeNoSelectionRoutingConfig,
  processNoSelectionAutoRouting,
}
