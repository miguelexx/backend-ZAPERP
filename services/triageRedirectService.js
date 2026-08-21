/**
 * Redirecionamento automático por falta de resposta ao menu de triagem.
 *
 * Para cada empresa com a função ativa, varre conversas onde o chatbot enviou o menu
 * mas o cliente não respondeu dentro do prazo configurado e ainda não tem setor.
 * Quando o prazo expira, encaminha para o setor padrão configurado.
 */

const supabase = require('../config/supabase')
const {
  DEFAULT_CHATBOT_CONFIG,
  transferToDepartment,
  logBotAction,
} = require('./chatbotTriageService')

function isTriageRedirectEmergencyDisabled() {
  const raw = String(process.env.TRIAGE_REDIRECT_EMERGENCY_DISABLED || '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

function getMaxRedirectsPerCycle() {
  const n = Number(process.env.TRIAGE_REDIRECT_MAX_PER_CYCLE)
  if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n))
  return 50
}

/**
 * Lê config de redirecionamento de todas as empresas que têm ia_config.
 * Retorna somente as que têm redirecionar_sem_resposta_ativo=true com departamento válido.
 */
async function loadCompaniesWithRedirectConfig() {
  const { data, error } = await supabase
    .from('ia_config')
    .select('company_id, config')

  if (error) {
    console.warn('[triageRedirect] erro ao buscar ia_config:', error.message)
    return []
  }

  const result = []
  for (const row of data || []) {
    const ct = row?.config?.chatbot_triage || {}
    const merged = { ...DEFAULT_CHATBOT_CONFIG, ...ct }

    if (!merged.redirecionar_sem_resposta_ativo) continue
    if (!merged.enabled) continue

    const depId = Number(merged.redirecionar_sem_resposta_departamento_id)
    if (!Number.isFinite(depId) || depId <= 0) continue

    const minutos = Number(merged.redirecionar_sem_resposta_minutos)
    const prazo = Number.isFinite(minutos) && minutos >= 1 ? Math.min(1440, minutos) : 5

    result.push({
      company_id: Number(row.company_id),
      departamento_id: depId,
      prazo_minutos: prazo,
      tipo_distribuicao: merged.tipo_distribuicao || 'fila',
      transferMode: merged.transferMode || 'departamento',
    })
  }

  return result
}

/**
 * Para uma empresa, encontra conversas elegíveis: menu enviado mas sem opção válida,
 * sem setor, sem atendente, e com prazo expirado.
 */
async function findEligibleConversas(company_id, prazo_minutos, maxConversas) {
  const prazoMs = prazo_minutos * 60 * 1000
  const corteIso = new Date(Date.now() - prazoMs).toISOString()

  // Busca bot_logs de menu_enviado expirados (criado_em < corte)
  const { data: logs, error: logsErr } = await supabase
    .from('bot_logs')
    .select('conversa_id, criado_em')
    .eq('company_id', company_id)
    .eq('tipo', 'menu_enviado')
    .lt('criado_em', corteIso)
    .order('criado_em', { ascending: true })
    .limit(maxConversas * 4) // busca extra para compensar filtros seguintes

  if (logsErr) {
    console.warn('[triageRedirect] erro ao buscar bot_logs:', logsErr.message)
    return []
  }
  if (!logs || logs.length === 0) return []

  // Deduplica: apenas o último menu_enviado por conversa
  const byConversa = new Map()
  for (const l of logs) {
    const cid = Number(l.conversa_id)
    if (!byConversa.has(cid) || new Date(l.criado_em) > new Date(byConversa.get(cid).criado_em)) {
      byConversa.set(cid, l)
    }
  }
  const conversaIds = [...byConversa.keys()]
  if (conversaIds.length === 0) return []

  // Filtra conversas que já têm opcao_valida (cliente já escolheu setor)
  const { data: withValid } = await supabase
    .from('bot_logs')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('tipo', 'opcao_valida')
    .in('conversa_id', conversaIds)

  const jaRespondeu = new Set((withValid || []).map((r) => Number(r.conversa_id)))

  // Filtra conversas que já foram redirecionadas
  const { data: withRedirect } = await supabase
    .from('bot_logs')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('tipo', 'redirecionamento_sem_resposta')
    .in('conversa_id', conversaIds)

  const jaRedirecionado = new Set((withRedirect || []).map((r) => Number(r.conversa_id)))

  const candidatos = conversaIds.filter((cid) => !jaRespondeu.has(cid) && !jaRedirecionado.has(cid))
  if (candidatos.length === 0) return []

  // Verifica no banco quais conversas ainda estão sem setor e sem atendente (atômico)
  const { data: conversas, error: convErr } = await supabase
    .from('conversas')
    .select('id, departamento_id, atendente_id, status_atendimento')
    .eq('company_id', company_id)
    .in('id', candidatos)
    .is('departamento_id', null)
    .is('atendente_id', null)
    .in('status_atendimento', ['aberta', 'aguardando_cliente'])

  if (convErr) {
    console.warn('[triageRedirect] erro ao verificar conversas:', convErr.message)
    return []
  }

  return (conversas || []).slice(0, maxConversas).map((c) => Number(c.id))
}

/**
 * Ciclo principal: processa todas as empresas elegíveis.
 */
async function redirectConversasByNoResponse(io) {
  if (isTriageRedirectEmergencyDisabled()) {
    return { ok: true, processadas: 0, analisadas: 0 }
  }

  let processadas = 0
  let analisadas = 0
  const maxPerCycle = getMaxRedirectsPerCycle()

  let companies
  try {
    companies = await loadCompaniesWithRedirectConfig()
  } catch (e) {
    console.warn('[triageRedirect] erro ao carregar empresas:', e?.message || e)
    return { ok: false, processadas: 0, analisadas: 0 }
  }

  for (const company of companies) {
    const { company_id, departamento_id, prazo_minutos, tipo_distribuicao, transferMode } = company

    let eligibleIds
    try {
      eligibleIds = await findEligibleConversas(company_id, prazo_minutos, maxPerCycle - processadas)
    } catch (e) {
      console.warn('[triageRedirect] erro ao buscar elegíveis para company', company_id, e?.message || e)
      continue
    }

    analisadas += eligibleIds.length

    for (const conversa_id of eligibleIds) {
      if (processadas >= maxPerCycle) break

      try {
        const result = await transferToDepartment(supabase, company_id, conversa_id, departamento_id, {
          transferMode,
          tipo_distribuicao,
        })

        if (!result?.ok) continue

        // Registra no bot_logs para evitar reprocessamento
        await logBotAction(company_id, conversa_id, 'redirecionamento_sem_resposta', {
          departamento_id,
          prazo_minutos,
        })

        processadas++

        // Emite realtime para o painel atualizar
        if (io) {
          io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: conversa_id })
          io.to(`conversa_${conversa_id}`).emit('conversa_atualizada', {
            id: conversa_id,
            departamento_id,
            status_atendimento: 'aberta',
            reordenar_suave: true,
          })
          io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
            id: conversa_id,
            departamento_id,
            status_atendimento: 'aberta',
            reordenar_suave: true,
          })
        }
      } catch (e) {
        console.warn('[triageRedirect] erro ao redirecionar conversa', conversa_id, e?.message || e)
      }
    }

    if (processadas >= maxPerCycle) break
  }

  return { ok: true, processadas, analisadas }
}

module.exports = { redirectConversasByNoResponse }
