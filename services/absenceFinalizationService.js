const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const {
  DEFAULT_CHATBOT_CONFIG,
  looksLikeBotMessage,
  logBotAction,
} = require('./chatbotTriageService')

const ABSENCE_FALLBACK_MESSAGE =
  'Seu atendimento foi encerrado por falta de interação no momento. Caso precise continuar, basta nos enviar uma nova mensagem.'

function isAbsenceFinalizationEnabledGlobally() {
  const raw = String(process.env.ABSENCE_FINALIZATION_GLOBAL_ENABLED || '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

function getAbsenceConfig(chatbotConfig) {
  const cfg = chatbotConfig || {}
  const globalEnabled = isAbsenceFinalizationEnabledGlobally()
  return {
    ativo: globalEnabled && !!cfg.finalizar_por_ausencia_ativo,
    prazo: Math.max(1, Number(cfg.finalizar_por_ausencia_prazo) || 24),
    unidade: String(cfg.finalizar_por_ausencia_unidade || 'horas_corridas').trim().toLowerCase(),
    mensagem: String(cfg.finalizar_por_ausencia_mensagem || '').trim() || ABSENCE_FALLBACK_MESSAGE,
    reabrirAutomaticamente: cfg.finalizar_por_ausencia_reabrir_automaticamente !== false,
    reabrirSemChatbot: cfg.finalizar_por_ausencia_reabrir_sem_chatbot !== false,
  }
}

/**
 * Uma leitura de ia_config por empresa: triagem completa (defaults) + política de ausência.
 */
async function loadChatbotTriageMergeAndAbsence(company_id) {
  if (!company_id) {
    return { triageMerged: { ...DEFAULT_CHATBOT_CONFIG }, absence: getAbsenceConfig(null) }
  }
  try {
    const { data, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()
    if (error || !data?.config || typeof data.config !== 'object') {
      return { triageMerged: { ...DEFAULT_CHATBOT_CONFIG }, absence: getAbsenceConfig(null) }
    }
    const raw = data.config.chatbot_triage && typeof data.config.chatbot_triage === 'object'
      ? data.config.chatbot_triage
      : {}
    const triageMerged = { ...DEFAULT_CHATBOT_CONFIG, ...raw }
    return { triageMerged, absence: getAbsenceConfig(triageMerged) }
  } catch (e) {
    console.warn('[absenceFinalization] loadChatbotTriageMergeAndAbsence:', e?.message || e)
    return { triageMerged: { ...DEFAULT_CHATBOT_CONFIG }, absence: getAbsenceConfig(null) }
  }
}

/**
 * Lê `ia_config.config.chatbot_triage` cru e mescla com defaults.
 * Necessário porque `validateChatbotConfig` pode retornar null (ex.: chatbot enabled sem opções),
 * mas a empresa ainda pode ter `finalizar_por_ausencia_*` válido no JSON.
 */
async function getAbsencePolicyForCompany(company_id) {
  const { absence } = await loadChatbotTriageMergeAndAbsence(company_id)
  return absence
}

/**
 * Texto outbound é do atendente humano (painel ou WhatsApp), não do chatbot de triagem nem da mensagem de ausência.
 * `textoEhSoMensagemAusencia`: só ausência configurada ou fallback fixo — não marca aguardando.
 */
function textoEhSoMensagemAusencia(texto, absenceCfg) {
  const t = String(texto || '').trim()
  if (!t) return false
  if (t === ABSENCE_FALLBACK_MESSAGE) return true
  const am = String(absenceCfg?.mensagem || '').trim()
  if (am && t === am) return true
  return false
}

function isHumanAttendantOutboundContent(texto, triageMerged, absenceCfg) {
  const t = String(texto || '').trim()
  if (!t) return false
  if (looksLikeBotMessage(t, triageMerged)) return false
  if (t === ABSENCE_FALLBACK_MESSAGE) return false
  const am = String(absenceCfg?.mensagem || '').trim()
  if (am && t === am) return false
  return true
}

/**
 * Mensagem outbound deve marcar "aguardando cliente"?
 * Painel/arquivo sempre têm autor_usuario_id → não usar looksLikeBotMessage no texto (evita falso positivo vs menu/invalidOption).
 */
function outboundQualificaParaAguardandoCliente(texto, autorUsuarioIdOpt, triageMerged, absenceCfg) {
  const uid = autorUsuarioIdOpt != null ? Number(autorUsuarioIdOpt) : NaN
  if (Number.isFinite(uid) && uid > 0) {
    const t = String(texto || '').trim()
    if (!t) return false
    return !textoEhSoMensagemAusencia(t, absenceCfg)
  }
  return isHumanAttendantOutboundContent(texto, triageMerged, absenceCfg)
}

function isHumanAttendantLastOutbound(lastMsg, triageMerged, absenceCfg) {
  if (!lastMsg || lastMsg.direcao !== 'out') return false
  const uid = lastMsg.autor_usuario_id
  if (uid != null && Number(uid) > 0) {
    const t = String(lastMsg.texto || '').trim()
    if (!t) return false
    if (t === ABSENCE_FALLBACK_MESSAGE) return false
    const am = String(absenceCfg?.mensagem || '').trim()
    if (am && t === am) return false
    return true
  }
  return isHumanAttendantOutboundContent(lastMsg.texto, triageMerged, absenceCfg)
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

/**
 * Marca `aguardando_cliente_desde` quando a última saída é humana (não bot / não mensagem de ausência).
 * Usado pelo webhook Z-API (eco fromMe) e pelo envio pelo painel (`enviarMensagemChat` etc.), pois esse fluxo não gera webhook confiável.
 */
async function tryMarkWaitingAfterHumanOutbound({ company_id, conversa_id, texto, criado_em, autor_usuario_id }) {
  if (!company_id || !conversa_id) return
  const ts = criado_em || new Date().toISOString()
  const { data: conv } = await supabase
    .from('conversas')
    .select('tipo, telefone, status_atendimento, atendente_id, aguardando_cliente_desde')
    .eq('id', conversa_id)
    .eq('company_id', company_id)
    .maybeSingle()
  const isGroup =
    String(conv?.tipo || '').toLowerCase() === 'grupo' || String(conv?.telefone || '').includes('@g.us')
  if (!conv || isGroup) return
  if (conv.status_atendimento !== 'em_atendimento' || conv.atendente_id == null) return
  const { triageMerged, absence: absenceCfg } = await loadChatbotTriageMergeAndAbsence(company_id)
  if (!outboundQualificaParaAguardandoCliente(texto, autor_usuario_id, triageMerged, absenceCfg)) return
  const jaAguardando = !!conv.aguardando_cliente_desde
  await markWaitingForClient(company_id, conversa_id, ts)
  if (!jaAguardando) {
    await supabase.from('historico_atendimentos').insert({
      conversa_id,
      usuario_id: Number(conv.atendente_id) || null,
      acao: 'aguardando_cliente',
      observacao: 'Conversa marcada como aguardando cliente após mensagem do atendente',
    })
  }
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
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

async function finalizeConversationsByAbsence() {
  if (!isAbsenceFinalizationEnabledGlobally()) {
    return { ok: true, processadas: 0, analisadas: 0, disabledByGlobalFlag: true }
  }
  const { data: configs } = await supabase.from('ia_config').select('company_id')
  if (!configs?.length) return { ok: true, processadas: 0, analisadas: 0 }

  const provider = getProvider()
  if (!provider?.sendText) return { ok: false, error: 'Provider de envio não disponível' }

  let processadas = 0
  let analisadas = 0

  for (const item of configs) {
    const company_id = item.company_id
    const { triageMerged, absence } = await loadChatbotTriageMergeAndAbsence(company_id)
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
      /* Regra explícita: só conversas em em_atendimento entram na query acima.
         status_atendimento = aguardando_cliente (manual) NUNCA é elegível ao encerramento por ausência. */
      if (conv.status_atendimento !== 'em_atendimento') continue
      const telefone = String(conv.telefone || '')
      if (!telefone || telefone.includes('@g.us') || telefone.toLowerCase().startsWith('lid:')) continue

      const lastMsg = await getLastMessage(conv.id, company_id)
      if (!lastMsg) continue
      // Última mensagem cronológica da conversa precisa ser outbound — senão o cliente já falou por último.
      if (lastMsg.direcao !== 'out') {
        await clearWaitingForClient(company_id, conv.id)
        continue
      }
      if (!isHumanAttendantLastOutbound(lastMsg, triageMerged, absence)) {
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

      // Revalidação imediata antes do UPDATE: evita encerrar se chegou inbound do cliente entre a leitura e o lock.
      const lastBeforeLock = await getLastMessage(conv.id, company_id)
      if (!lastBeforeLock || lastBeforeLock.direcao !== 'out') {
        await clearWaitingForClient(company_id, conv.id)
        continue
      }
      if (!isHumanAttendantLastOutbound(lastBeforeLock, triageMerged, absence)) {
        await clearWaitingForClient(company_id, conv.id)
        continue
      }
      const aguardandoParaLock = lastBeforeLock.criado_em
      if (new Date(aguardandoParaLock).toISOString() > cutoff) continue

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
            aguardando_cliente_desde: aguardandoParaLock,
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
  loadChatbotTriageMergeAndAbsence,
  isHumanAttendantOutboundContent,
  outboundQualificaParaAguardandoCliente,
  isHumanAttendantLastOutbound,
  markWaitingForClient,
  clearWaitingForClient,
  tryMarkWaitingAfterHumanOutbound,
  finalizeConversationsByAbsence,
}
