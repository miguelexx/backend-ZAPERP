const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const {
  DEFAULT_CHATBOT_CONFIG,
  looksLikeBotMessage,
  logBotAction,
} = require('./chatbotTriageService')

const ABSENCE_FALLBACK_MESSAGE =
  'Seu atendimento foi encerrado por falta de interação no momento. Caso precise continuar, basta nos enviar uma nova mensagem.'

const CONFIRM_FINALIZE_ABSENCE = 'FINALIZAR_AUSENCIA_CLIENTE'
const CONFIRM_FINALIZE_ABSENCE_BATCH = 'FINALIZAR_LOTE_AUSENCIA_CLIENTE'
const SNAP_PREFIX = '|ausencia_snap:'

function isAbsenceFinalizationEmergencyDisabled() {
  const raw = String(process.env.ABSENCE_FINALIZATION_EMERGENCY_DISABLED || '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

function getMaxFinalizationsPerCycle() {
  const n = Number(process.env.ABSENCE_FINALIZATION_MAX_PER_CYCLE)
  if (Number.isFinite(n) && n >= 1) return Math.min(500, Math.floor(n))
  return 12
}

function getScanLimitPerCompany() {
  const n = Number(process.env.ABSENCE_FINALIZATION_SCAN_LIMIT)
  if (Number.isFinite(n) && n >= 10) return Math.min(2000, Math.floor(n))
  return 250
}

function getAbsenceConfig(chatbotConfig) {
  const cfg = chatbotConfig || {}
  return {
    ativo: !!cfg.finalizar_por_ausencia_ativo,
    prazo: Math.max(1, Number(cfg.finalizar_por_ausencia_prazo) || 24),
    unidade: String(cfg.finalizar_por_ausencia_unidade || 'horas_corridas').trim().toLowerCase(),
    mensagem: String(cfg.finalizar_por_ausencia_mensagem || '').trim() || ABSENCE_FALLBACK_MESSAGE,
    reabrirAutomaticamente: cfg.finalizar_por_ausencia_reabrir_automaticamente !== false,
    reabrirSemChatbot: cfg.finalizar_por_ausencia_reabrir_sem_chatbot !== false,
    timezone: String(cfg.timezone || DEFAULT_CHATBOT_CONFIG.timezone || 'America/Sao_Paulo').trim() || 'America/Sao_Paulo',
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
    const raw =
      data.config.chatbot_triage && typeof data.config.chatbot_triage === 'object'
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

/**
 * Retorna o timestamp efetivo do início do prazo de ausência.
 * Se o atendente assumiu/reabriu a conversa DEPOIS da última mensagem enviada,
 * o prazo deve contar a partir da assunção — não da mensagem antiga.
 * Isso evita que o scheduler feche imediatamente conversas recém-reabertas.
 */
function resolveAguardandoDesde(atendente_atribuido_em, lastMsgCriadoEm) {
  if (!atendente_atribuido_em) return lastMsgCriadoEm
  const tAtrib = new Date(atendente_atribuido_em).getTime()
  const tMsg = new Date(lastMsgCriadoEm).getTime()
  if (Number.isFinite(tAtrib) && tAtrib > tMsg) return atendente_atribuido_em
  return lastMsgCriadoEm
}

/**
 * Prazo em horas (config da tela). `horas_uteis` ainda usa horas corridas no relógio — evolução futura: janelas comerciais.
 * `timezone` da empresa entra em logs/preview e em evoluções de horas úteis.
 */
function getCutoffDate(absence) {
  const hours = absence.prazo
  if (absence.unidade === 'horas_uteis') {
    return new Date(Date.now() - hours * 60 * 60 * 1000)
  }
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

function buildEncerramentoObservacao({ prazo, unidade, snap }) {
  const base = `Conversa encerrada automaticamente por ausência do cliente (prazo ${prazo} ${unidade})`
  if (!snap || (snap.atendente_id == null && snap.departamento_id == null)) return base
  try {
    return `${base}${SNAP_PREFIX}${JSON.stringify(snap)}`
  } catch (_) {
    return base
  }
}

function parseAbsenceSnapFromObservacao(observacao) {
  const s = String(observacao || '')
  const idx = s.indexOf(SNAP_PREFIX)
  if (idx < 0) return null
  try {
    const parsed = JSON.parse(s.slice(idx + SNAP_PREFIX.length))
    if (!parsed || typeof parsed !== 'object') return null
    const atendente_id = parsed.atendente_id != null ? Number(parsed.atendente_id) : null
    const departamento_id = parsed.departamento_id != null ? Number(parsed.departamento_id) : null
    return {
      atendente_id: Number.isFinite(atendente_id) && atendente_id > 0 ? atendente_id : null,
      departamento_id: Number.isFinite(departamento_id) && departamento_id > 0 ? departamento_id : null,
    }
  } catch (_) {
    return null
  }
}

async function fetchLastAbsenceEncerramentoSnap(conversa_id) {
  const { data } = await supabase
    .from('historico_atendimentos')
    .select('observacao')
    .eq('conversa_id', conversa_id)
    .eq('acao', 'encerramento_automatico_ausencia')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  return parseAbsenceSnapFromObservacao(data?.observacao)
}

/**
 * Reabrir em atendimento só se o atendente do snapshot ainda existir e estiver ativo na empresa.
 */
async function resolveReopenAssignmentAfterAbsence(company_id, snap) {
  const cidEmp = Number(company_id)
  if (!Number.isFinite(cidEmp) || cidEmp <= 0) {
    return { status_atendimento: 'aberta', atendente_id: null, atendente_atribuido_em: null }
  }
  const aid = snap?.atendente_id != null ? Number(snap.atendente_id) : null
  if (!aid || aid <= 0) {
    return { status_atendimento: 'aberta', atendente_id: null, atendente_atribuido_em: null }
  }
  try {
    const { data: u } = await supabase
      .from('usuarios')
      .select('id')
      .eq('company_id', cidEmp)
      .eq('id', aid)
      .eq('ativo', true)
      .maybeSingle()
    if (!u?.id) {
      return { status_atendimento: 'aberta', atendente_id: null, atendente_atribuido_em: null }
    }
    return {
      status_atendimento: 'em_atendimento',
      atendente_id: Number(u.id),
      atendente_atribuido_em: new Date().toISOString(),
    }
  } catch (_) {
    return { status_atendimento: 'aberta', atendente_id: null, atendente_atribuido_em: null }
  }
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
  await supabase.from('conversas').update({ aguardando_cliente_desde: null }).eq('company_id', company_id).eq('id', conversa_id)
}

async function tryMarkWaitingAfterHumanOutbound({ company_id, conversa_id, texto, criado_em, autor_usuario_id }) {
  if (!company_id || !conversa_id) return { marked: false, reason: 'missing_context' }
  const ts = criado_em || new Date().toISOString()
  const { data: conv } = await supabase
    .from('conversas')
    .select('tipo, telefone, status_atendimento, atendente_id, aguardando_cliente_desde')
    .eq('id', conversa_id)
    .eq('company_id', company_id)
    .maybeSingle()
  const isGroup =
    String(conv?.tipo || '').toLowerCase() === 'grupo' || String(conv?.telefone || '').includes('@g.us')
  if (!conv || isGroup) return { marked: false, reason: 'not_eligible_conversation' }
  if (conv.status_atendimento !== 'em_atendimento' || conv.atendente_id == null) {
    return { marked: false, reason: 'not_in_human_attendance' }
  }
  const { triageMerged, absence: absenceCfg } = await loadChatbotTriageMergeAndAbsence(company_id)
  if (!outboundQualificaParaAguardandoCliente(texto, autor_usuario_id, triageMerged, absenceCfg)) {
    return { marked: false, reason: 'message_not_qualified' }
  }
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
  return { marked: true, aguardando_cliente_desde: ts, jaAguardando }
}

async function sendAbsenceClosingMessage({ provider, company_id, conversa_id, telefone, mensagem }) {
  const { data: row } = await supabase
    .from('conversas')
    .select('ausencia_mensagem_enviada_em, finalizacao_motivo')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .maybeSingle()
  if (row?.ausencia_mensagem_enviada_em) {
    return { ok: true, skippedDuplicate: true }
  }
  const result = await provider.sendText(telefone, mensagem, {
    companyId: company_id,
    conversaId: conversa_id,
    sendOrigin: 'finalizacao_ausencia_cliente',
  })
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

async function hasInboundAfterTimestamp(company_id, conversa_id, tsIso) {
  if (!tsIso) return false
  const { count, error } = await supabase
    .from('mensagens')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('direcao', 'in')
    .gt('criado_em', tsIso)
  if (error) return true
  return Number(count || 0) > 0
}

function msIdleFromLastOutbound(lastCriadoEm) {
  if (!lastCriadoEm) return null
  const t = new Date(lastCriadoEm).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Date.now() - t)
}

/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun] — só simula (sem UPDATE de encerramento / sem envio)
 * @param {boolean} [opts.execute] — quando false, equivalente a dry-run
 * @param {string} [opts.source] — 'scheduler' | 'http' | 'batch'
 */
async function finalizeConversationsByAbsence(opts = {}) {
  const dryRun = opts.dryRun === true || opts.execute === false
  if (isAbsenceFinalizationEmergencyDisabled()) {
    return { ok: true, processadas: 0, analisadas: 0, dryRun, emergencyDisabled: true, candidatos: [] }
  }

  const { data: configs } = await supabase.from('ia_config').select('company_id')
  if (!configs?.length) return { ok: true, processadas: 0, analisadas: 0, dryRun, candidatos: [] }

  const maxPerCycle = getMaxFinalizationsPerCycle()
  const scanLimit = getScanLimitPerCompany()
  const provider = dryRun ? null : getProvider()
  if (!dryRun && (!provider?.sendText)) {
    return { ok: false, error: 'Provider de envio não disponível' }
  }

  let processadas = 0
  let analisadas = 0
  /** @type {object[]} */
  const candidatos = []

  for (const item of configs) {
    const company_id = Number(item.company_id)

    const { triageMerged, absence } = await loadChatbotTriageMergeAndAbsence(company_id)
    if (!absence.ativo) continue

    const cutoff = getCutoffDate(absence).toISOString()
    const cutoffMs = new Date(cutoff).getTime()

    const { data: conversas } = await supabase
      .from('conversas')
      .select(
        'id, telefone, status_atendimento, atendente_id, atendente_atribuido_em, aguardando_cliente_desde, finalizacao_motivo, tipo, departamento_id, cliente_id'
      )
      .eq('company_id', company_id)
      .eq('status_atendimento', 'em_atendimento')
      .not('atendente_id', 'is', null)
      .neq('tipo', 'grupo')
      .or(`finalizacao_motivo.is.null,finalizacao_motivo.neq.ausencia_cliente`)
      .order('ultima_atividade', { ascending: true, nullsFirst: true })
      .limit(scanLimit)

    for (const conv of conversas || []) {
      if (!dryRun && processadas >= maxPerCycle) {
        return {
          ok: true,
          processadas,
          analisadas,
          dryRun,
          truncatedByMaxPerCycle: true,
          candidatos,
          aviso: `Limite de ${maxPerCycle} finalizações por ciclo atingido; rode novamente para continuar.`,
        }
      }

      analisadas++
      if (!conv?.id) continue
      if (conv.status_atendimento !== 'em_atendimento') continue
      const telefone = String(conv.telefone || '')
      if (!telefone || telefone.includes('@g.us') || telefone.toLowerCase().startsWith('lid:')) continue

      const lastMsg = await getLastMessage(conv.id, company_id)
      if (!lastMsg) continue
      if (lastMsg.direcao !== 'out') {
        if (!dryRun) await clearWaitingForClient(company_id, conv.id)
        continue
      }
      if (!isHumanAttendantLastOutbound(lastMsg, triageMerged, absence)) {
        if (!dryRun) await clearWaitingForClient(company_id, conv.id)
        continue
      }

      // Se o atendente assumiu/reabriu depois da última msg, o prazo conta da assunção
      const aguardandoDesde = resolveAguardandoDesde(conv.atendente_atribuido_em, lastMsg.criado_em)
      const inboundRecente = await hasInboundAfterTimestamp(company_id, conv.id, aguardandoDesde)
      if (inboundRecente) {
        if (!dryRun) await clearWaitingForClient(company_id, conv.id)
        continue
      }

      if (!dryRun) {
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
      }

      if (new Date(aguardandoDesde).getTime() > cutoffMs) continue

      const lastBeforeLock = dryRun ? lastMsg : await getLastMessage(conv.id, company_id)
      if (!lastBeforeLock || lastBeforeLock.direcao !== 'out') {
        if (!dryRun) await clearWaitingForClient(company_id, conv.id)
        continue
      }
      if (!isHumanAttendantLastOutbound(lastBeforeLock, triageMerged, absence)) {
        if (!dryRun) await clearWaitingForClient(company_id, conv.id)
        continue
      }
      const aguardandoParaLock = lastBeforeLock.criado_em
      if (new Date(aguardandoParaLock).getTime() > cutoffMs) continue
      if (!dryRun && (await hasInboundAfterTimestamp(company_id, conv.id, aguardandoParaLock))) {
        await clearWaitingForClient(company_id, conv.id)
        continue
      }

      const idleMs = msIdleFromLastOutbound(aguardandoParaLock)
      const clienteLabel = conv.cliente_id ? `cliente_id:${conv.cliente_id}` : telefone
      const ultimoAutor =
        lastBeforeLock.autor_usuario_id != null && Number(lastBeforeLock.autor_usuario_id) > 0
          ? `atendente_usuario:${lastBeforeLock.autor_usuario_id}`
          : 'atendente_sistema_ou_whatsapp'

      if (dryRun) {
        if (candidatos.length >= maxPerCycle) {
          return {
            ok: true,
            processadas: 0,
            analisadas,
            dryRun: true,
            candidatos,
            truncatedByMaxPerCycle: true,
            aviso: `Pré-visualização limitada a ${maxPerCycle} conversas por ciclo.`,
          }
        }
        candidatos.push({
          company_id,
          conversa_id: conv.id,
          cliente: clienteLabel,
          telefone,
          ultima_mensagem_texto: String(lastBeforeLock.texto || '').slice(0, 200),
          ultima_mensagem_direcao: lastBeforeLock.direcao,
          ultima_mensagem_quem: ultimoAutor,
          ultima_mensagem_criado_em: aguardandoParaLock,
          tempo_parado_ms: idleMs,
          tempo_parado_h: idleMs != null ? Number((idleMs / 3600000).toFixed(2)) : null,
          prazo_config_h: absence.prazo,
          unidade: absence.unidade,
          timezone_config: absence.timezone,
        })
        continue
      }

      const prevAtendenteId = conv.atendente_id != null ? Number(conv.atendente_id) : null
      const prevAtendenteAtribuidoEm = conv.atendente_atribuido_em || null
      const prevDepartamentoId = conv.departamento_id != null ? Number(conv.departamento_id) : null
      const snap = {
        atendente_id: prevAtendenteId,
        departamento_id: Number.isFinite(prevDepartamentoId) && prevDepartamentoId > 0 ? prevDepartamentoId : null,
      }

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
      let skippedDuplicate = false
      try {
        const sendRes = await sendAbsenceClosingMessage({
          provider,
          company_id,
          conversa_id: conv.id,
          telefone,
          mensagem: absence.mensagem,
        })
        sendOk = !!sendRes?.ok
        skippedDuplicate = !!sendRes?.skippedDuplicate
      } catch (e) {
        console.warn('[absenceFinalization] erro ao enviar mensagem de encerramento:', e?.message || e)
      }

      if (!sendOk && !skippedDuplicate) {
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

      const observacaoEncerramento = buildEncerramentoObservacao({
        prazo: absence.prazo,
        unidade: absence.unidade,
        snap,
      })
      await supabase.from('historico_atendimentos').insert({
        conversa_id: conv.id,
        usuario_id: null,
        acao: 'encerramento_automatico_ausencia',
        observacao: observacaoEncerramento,
      })
      await logBotAction(company_id, conv.id, 'encerramento_automatico_ausencia', {
        prazo: absence.prazo,
        unidade: absence.unidade,
        timezone: absence.timezone,
        snap,
        skippedDuplicate,
      })
      processadas++
    }
  }

  return { ok: true, processadas, analisadas, dryRun, candidatos, maxPerCycle }
}

/**
 * Finalização em lote (futuro / operação): só com confirmação explícita e limite de quantidade.
 * @param {object} p
 * @param {number} p.company_id
 * @param {number[]} p.conversa_ids
 * @param {boolean} p.dryRun
 * @param {boolean} p.execute
 * @param {string} p.confirm
 */
async function finalizeAbsenceForConversaIds(p) {
  const company_id = Number(p.company_id)
  const dryRun = !!p.dryRun
  if (isAbsenceFinalizationEmergencyDisabled()) {
    return {
      ok: false,
      emergencyDisabled: true,
      error: 'Finalização por ausência pausada por kill switch emergencial (ABSENCE_FINALIZATION_EMERGENCY_DISABLED).',
    }
  }

  if (p.execute === true && String(p.confirm || '').trim() !== CONFIRM_FINALIZE_ABSENCE_BATCH) {
    return { ok: false, error: `Para executar o lote, informe confirm: "${CONFIRM_FINALIZE_ABSENCE_BATCH}".` }
  }
  const execute = !!p.execute && !dryRun

  const ids = Array.isArray(p.conversa_ids) ? p.conversa_ids.map((x) => Number(x)).filter((n) => n > 0) : []
  if (!ids.length) return { ok: false, error: 'Informe conversa_ids (array de inteiros).' }
  const maxBatch = Number(process.env.ABSENCE_FINALIZATION_LOTE_MAX) || 50
  if (ids.length > maxBatch) {
    return { ok: false, error: `Máximo de ${maxBatch} conversas por lote. Reduza a lista ou ajuste ABSENCE_FINALIZATION_LOTE_MAX.` }
  }

  const { triageMerged, absence } = await loadChatbotTriageMergeAndAbsence(company_id)
  if (!absence.ativo) {
    return { ok: false, error: 'Política de ausência desativada para esta empresa.' }
  }

  const provider = dryRun ? null : getProvider()
  if (execute && !provider?.sendText) return { ok: false, error: 'Provider de envio não disponível' }

  const cutoff = getCutoffDate(absence).toISOString()
  const cutoffMs = new Date(cutoff).getTime()
  const resultados = []

  for (const convId of ids) {
    const { data: conv } = await supabase
      .from('conversas')
      .select(
        'id, telefone, status_atendimento, atendente_id, atendente_atribuido_em, aguardando_cliente_desde, finalizacao_motivo, tipo, departamento_id, cliente_id'
      )
      .eq('company_id', company_id)
      .eq('id', convId)
      .maybeSingle()
    if (!conv || conv.status_atendimento !== 'em_atendimento' || conv.atendente_id == null) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'nao_elegivel_estado' })
      continue
    }
    if (String(conv.tipo || '').toLowerCase() === 'grupo') {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'grupo' })
      continue
    }
    const telefone = String(conv.telefone || '')
    if (!telefone || telefone.includes('@g.us') || telefone.toLowerCase().startsWith('lid:')) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'telefone_invalido' })
      continue
    }

    const lastMsg = await getLastMessage(conv.id, company_id)
    if (!lastMsg || lastMsg.direcao !== 'out' || !isHumanAttendantLastOutbound(lastMsg, triageMerged, absence)) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'ultima_nao_e_atendente' })
      continue
    }
    // Se o atendente assumiu/reabriu depois da última msg, o prazo conta da assunção
    const aguardandoDesde = resolveAguardandoDesde(conv.atendente_atribuido_em, lastMsg.criado_em)
    if (await hasInboundAfterTimestamp(company_id, conv.id, aguardandoDesde)) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'cliente_respondeu_depois' })
      continue
    }
    if (new Date(aguardandoDesde).getTime() > cutoffMs) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'prazo_nao_cumprido' })
      continue
    }

    if (dryRun || !execute) {
      resultados.push({
        conversa_id: convId,
        ok: true,
        dryRun: true,
        preview: {
          ultima_mensagem_criado_em: lastMsg.criado_em,
          aguardando_desde: aguardandoDesde,
          tempo_parado_h: msIdleFromLastOutbound(aguardandoDesde) / 3600000,
        },
      })
      continue
    }

    const prevAtendenteId = conv.atendente_id != null ? Number(conv.atendente_id) : null
    const prevAtendenteAtribuidoEm = conv.atendente_atribuido_em || null
    const prevDepartamentoId = conv.departamento_id != null ? Number(conv.departamento_id) : null
    const snap = {
      atendente_id: prevAtendenteId,
      departamento_id: Number.isFinite(prevDepartamentoId) && prevDepartamentoId > 0 ? prevDepartamentoId : null,
    }
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

    if (!locked?.id) {
      resultados.push({ conversa_id: convId, ok: false, motivo: 'lock_ou_ja_processada' })
      continue
    }

    let sendOk = false
    let skippedDuplicate = false
    try {
      const sendRes = await sendAbsenceClosingMessage({
        provider,
        company_id,
        conversa_id: conv.id,
        telefone,
        mensagem: absence.mensagem,
      })
      sendOk = !!sendRes?.ok
      skippedDuplicate = !!sendRes?.skippedDuplicate
    } catch (e) {
      console.warn('[absenceFinalization][lote] envio:', e?.message || e)
    }

    if (!sendOk && !skippedDuplicate) {
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
          aguardando_cliente_desde: lastMsg.criado_em,
        })
        .eq('company_id', company_id)
        .eq('id', conv.id)
        .eq('finalizacao_motivo', 'ausencia_cliente')
      resultados.push({ conversa_id: convId, ok: false, motivo: 'falha_envio' })
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
      observacao: buildEncerramentoObservacao({
        prazo: absence.prazo,
        unidade: absence.unidade,
        snap,
      }),
    })
    await logBotAction(company_id, conv.id, 'encerramento_automatico_ausencia_lote', {
      prazo: absence.prazo,
      unidade: absence.unidade,
      snap,
      skippedDuplicate,
    })
    resultados.push({ conversa_id: convId, ok: true })
  }

  return { ok: true, dryRun: !execute, resultados }
}

module.exports = {
  ABSENCE_FALLBACK_MESSAGE,
  CONFIRM_FINALIZE_ABSENCE,
  CONFIRM_FINALIZE_ABSENCE_BATCH,
  isAbsenceFinalizationEmergencyDisabled,
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
  finalizeAbsenceForConversaIds,
  fetchLastAbsenceEncerramentoSnap,
  parseAbsenceSnapFromObservacao,
  resolveReopenAssignmentAfterAbsence,
}
