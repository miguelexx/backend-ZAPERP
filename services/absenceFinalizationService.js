const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { DEFAULT_CHATBOT_CONFIG, logBotAction } = require('./chatbotTriageService')

const ABSENCE_FALLBACK_MESSAGE =
  'Seu atendimento foi encerrado por falta de interação no momento. Caso precise continuar, basta nos enviar uma nova mensagem.'

function getAbsenceConfig(chatbotConfig) {
  const cfg = chatbotConfig || {}
  return {
    ativo: !!cfg.finalizar_por_ausencia_ativo,
    prazo: Math.max(1, Number(cfg.finalizar_por_ausencia_prazo) || 24),
    unidade: String(cfg.finalizar_por_ausencia_unidade || 'horas_corridas').trim().toLowerCase(),
    mensagem: String(cfg.finalizar_por_ausencia_mensagem || '').trim() || ABSENCE_FALLBACK_MESSAGE,
    reabrirAutomaticamente: cfg.finalizar_por_ausencia_reabrir_automaticamente !== false,
    reabrirSemChatbot: cfg.finalizar_por_ausencia_reabrir_sem_chatbot !== false,
  }
}

/**
 * Lê `ia_config.config.chatbot_triage` cru e mescla com defaults.
 * Necessário porque `validateChatbotConfig` pode retornar null (ex.: chatbot enabled sem opções),
 * mas a empresa ainda pode ter `finalizar_por_ausencia_*` válido no JSON.
 */
async function getAbsencePolicyForCompany(company_id) {
  if (!company_id) return getAbsenceConfig(null)
  try {
    const { data, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()
    if (error || !data?.config || typeof data.config !== 'object') return getAbsenceConfig(null)
    const raw = data.config.chatbot_triage && typeof data.config.chatbot_triage === 'object'
      ? data.config.chatbot_triage
      : {}
    return getAbsenceConfig({ ...DEFAULT_CHATBOT_CONFIG, ...raw })
  } catch (e) {
    console.warn('[absenceFinalization] getAbsencePolicyForCompany:', e?.message || e)
    return getAbsenceConfig(null)
  }
}

function getCutoffDate(cfg) {
  if (cfg.unidade === 'horas_uteis') {
    // Base preparada para evolução futura; por ora mantém comportamento em horas corridas.
    return new Date(Date.now() - cfg.prazo * 60 * 60 * 1000)
  }
  return new Date(Date.now() - cfg.prazo * 60 * 60 * 1000)
}

async function markWaitingForClient(company_id, conversa_id, aguardandoDesde = null) {
  if (!company_id || !conversa_id) return
  const ts = aguardandoDesde || new Date().toISOString()
  await supabase
    .from('conversas')
    .update({
      aguardando_cliente_desde: ts,
      finalizacao_motivo: null,
      finalizada_automaticamente: false,
      finalizada_automaticamente_em: null,
    })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .neq('status_atendimento', 'fechada')
}

async function clearWaitingForClient(company_id, conversa_id) {
  if (!company_id || !conversa_id) return
  await supabase
    .from('conversas')
    .update({ aguardando_cliente_desde: null })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
}

async function sendAbsenceClosingMessage({ provider, company_id, conversa_id, telefone, mensagem }) {
  const result = await provider.sendText(telefone, mensagem, { companyId: company_id, conversaId: conversa_id })
  const ok = !!result?.ok
  if (!ok) return { ok: false }
  await supabase.from('mensagens').insert({
    conversa_id,
    texto: mensagem,
    direcao: 'out',
    company_id,
    status: 'sent',
  })
  return { ok: true }
}

async function getLastMessage(conversa_id, company_id) {
  const { data } = await supabase
    .from('mensagens')
    .select('id, direcao, criado_em, autor_usuario_id, texto')
    .eq('conversa_id', conversa_id)
    .eq('company_id', company_id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

async function finalizeConversationsByAbsence() {
  const { data: configs } = await supabase.from('ia_config').select('company_id')
  if (!configs?.length) return { ok: true, processadas: 0, analisadas: 0 }

  const provider = getProvider()
  if (!provider?.sendText) return { ok: false, error: 'Provider de envio não disponível' }

  let processadas = 0
  let analisadas = 0

  for (const item of configs) {
    const company_id = item.company_id
    const absence = await getAbsencePolicyForCompany(company_id)
    if (!absence.ativo) continue

    const cutoff = getCutoffDate(absence).toISOString()
    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, telefone, status_atendimento, atendente_id, atendente_atribuido_em, aguardando_cliente_desde, finalizacao_motivo, tipo')
      .eq('company_id', company_id)
      .eq('status_atendimento', 'em_atendimento')
      .not('atendente_id', 'is', null)
      .neq('tipo', 'grupo')
      .or(`finalizacao_motivo.is.null,finalizacao_motivo.neq.ausencia_cliente`)
      .limit(1000)

    for (const conv of conversas || []) {
      analisadas++
      if (!conv?.id) continue
      const telefone = String(conv.telefone || '')
      if (!telefone || telefone.includes('@g.us') || telefone.toLowerCase().startsWith('lid:')) continue

      const lastMsg = await getLastMessage(conv.id, company_id)
      if (!lastMsg) continue
      if (lastMsg.direcao !== 'out') {
        await clearWaitingForClient(company_id, conv.id)
        continue
      }

      // Prazo sempre a partir da última mensagem outbound real (atendente/sistema), não de um aguardando antigo no banco.
      const aguardandoDesde = lastMsg.criado_em
      const jaAguardandoCol = !!conv.aguardando_cliente_desde
      await markWaitingForClient(company_id, conv.id, aguardandoDesde)
      if (!jaAguardandoCol) {
        await supabase.from('historico_atendimentos').insert({
          conversa_id: conv.id,
          usuario_id: null,
          acao: 'aguardando_cliente',
          observacao: 'Conversa marcada como aguardando cliente após última mensagem do atendente (job)',
        })
      }

      if (new Date(aguardandoDesde).toISOString() > cutoff) continue

      const prevAtendenteId = conv.atendente_id != null ? Number(conv.atendente_id) : null
      const prevAtendenteAtribuidoEm = conv.atendente_atribuido_em || null

      const nowIso = new Date().toISOString()
      const { data: locked } = await supabase
        .from('conversas')
        .update({
          status_atendimento: 'fechada',
          finalizacao_motivo: 'ausencia_cliente',
          finalizada_automaticamente: true,
          finalizada_automaticamente_em: nowIso,
          ausencia_mensagem_enviada_em: null,
          atendente_id: null,
          atendente_atribuido_em: null,
        })
        .eq('company_id', company_id)
        .eq('id', conv.id)
        .eq('status_atendimento', 'em_atendimento')
        .is('finalizada_automaticamente_em', null)
        .select('id')
        .maybeSingle()

      if (!locked?.id) continue

      let sendOk = false
      try {
        const sendRes = await sendAbsenceClosingMessage({
          provider,
          company_id,
          conversa_id: conv.id,
          telefone,
          mensagem: absence.mensagem,
        })
        sendOk = !!sendRes?.ok
      } catch (e) {
        console.warn('[absenceFinalization] erro ao enviar mensagem de encerramento:', e?.message || e)
      }

      if (!sendOk) {
        await supabase
          .from('conversas')
          .update({
            status_atendimento: 'em_atendimento',
            atendente_id: prevAtendenteId,
            atendente_atribuido_em: prevAtendenteId ? prevAtendenteAtribuidoEm : null,
            finalizacao_motivo: null,
            finalizada_automaticamente: false,
            finalizada_automaticamente_em: null,
            ausencia_mensagem_enviada_em: null,
            aguardando_cliente_desde: aguardandoDesde,
          })
          .eq('company_id', company_id)
          .eq('id', conv.id)
          .eq('finalizacao_motivo', 'ausencia_cliente')
        await supabase.from('historico_atendimentos').insert({
          conversa_id: conv.id,
          usuario_id: null,
          acao: 'encerramento_ausencia_falha_envio',
          observacao: 'Falha ao enviar mensagem de encerramento por ausência — conversa revertida para em atendimento',
        })
        await logBotAction(company_id, conv.id, 'encerramento_ausencia_falha_envio', { prazo: absence.prazo, unidade: absence.unidade })
        continue
      }

      await supabase
        .from('conversas')
        .update({ ausencia_mensagem_enviada_em: nowIso })
        .eq('company_id', company_id)
        .eq('id', conv.id)
        .eq('finalizacao_motivo', 'ausencia_cliente')

      await supabase.from('historico_atendimentos').insert({
        conversa_id: conv.id,
        usuario_id: null,
        acao: 'encerramento_automatico_ausencia',
        observacao: `Conversa encerrada automaticamente por ausência do cliente (prazo ${absence.prazo} ${absence.unidade})`,
      })
      await logBotAction(company_id, conv.id, 'encerramento_automatico_ausencia', {
        prazo: absence.prazo,
        unidade: absence.unidade,
      })
      processadas++
    }
  }

  return { ok: true, processadas, analisadas }
}

module.exports = {
  ABSENCE_FALLBACK_MESSAGE,
  getAbsenceConfig,
  getAbsencePolicyForCompany,
  markWaitingForClient,
  clearWaitingForClient,
  finalizeConversationsByAbsence,
}
