/**
 * Alerta diário (cron) com resumo de atendimento para número do administrador — config em ia_config.config.admin_atendimento_alerta.
 * Idempotência: tabela admin_atendimento_alerta_envios (company_id + dia_local).
 */

const supabase = require('../config/supabase')
const { getAguardandoFuncionarioParaAlertaAdmin } = require('./supervisaoService')

/** Minutos após o horário em que ainda dispara (scheduler a cada 1–2 min + relógios; fim inclusivo). */
const CRON_GRACE_MINUTES = 30
const AVALIACOES_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

const DEFAULT_ADMIN_ATENDIMENTO_ALERTA = {
  ativo: false,
  cliente_id: null,
  cliente_nome: '',
  telefone_admin: '',
  horario_envio: '09:00',
  /** Vazio = herdar chatbot_triage.timezone */
  timezone: '',
  incluir_nota_media: false,
  incluir_conversas_sem_resposta: false,
}

function normalizeHorarioEnvio(value) {
  const raw = String(value || '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return '09:00'
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)))
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function coerceAtivo(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())) return true
  return false
}

function isChatbotTriageEnabled(ct) {
  if (!ct || typeof ct !== 'object') return false
  return coerceAtivo(ct.enabled)
}

function normalizeAdminAtendimentoAlerta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const tz = String(r.timezone || '').trim()
  const clienteId = Number(r.cliente_id)
  return {
    ativo: coerceAtivo(r.ativo),
    cliente_id: Number.isInteger(clienteId) && clienteId > 0 ? clienteId : null,
    cliente_nome: String(r.cliente_nome || '').trim().slice(0, 120),
    telefone_admin: String(r.telefone_admin || '').trim().slice(0, 40),
    horario_envio: normalizeHorarioEnvio(r.horario_envio),
    timezone: tz.length > 0 ? tz.slice(0, 80) : '',
    incluir_nota_media: r.incluir_nota_media === true,
    incluir_conversas_sem_resposta: r.incluir_conversas_sem_resposta === true,
  }
}

function resolveTimezone(alert, fullConfig) {
  const fromAlert = String(alert?.timezone || '').trim()
  if (fromAlert) return fromAlert
  const fromChatbot = String(fullConfig?.chatbot_triage?.timezone || '').trim()
  if (fromChatbot) return fromChatbot
  return 'America/Sao_Paulo'
}

function zonedYmdHm(date, timeZone) {
  const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : 'America/Sao_Paulo'
  const dp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const g = (t) => dp.find((p) => p.type === t)?.value || '0'
  const pad2 = (x) => String(x).replace(/\D/g, '').slice(0, 2).padStart(2, '0') || '00'
  let hour = parseInt(pad2(g('hour')), 10)
  if (!Number.isFinite(hour)) hour = 0
  if (hour === 24) hour = 0
  hour = Math.max(0, Math.min(23, hour))
  return {
    ymd: `${g('year')}-${pad2(g('month'))}-${pad2(g('day'))}`,
    hm: `${String(hour).padStart(2, '0')}:${pad2(g('minute'))}`,
  }
}

function hmToMinutes(hm) {
  const m = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return h * 60 + min
}

function isWithinDispatchWindow(scheduledHm, nowHm, graceMinutes) {
  const t0 = hmToMinutes(scheduledHm)
  const t1 = hmToMinutes(nowHm)
  if (t0 == null || t1 == null) return false
  const grace = Math.max(1, Number(graceMinutes) || CRON_GRACE_MINUTES)
  return t1 >= t0 && t1 <= t0 + grace
}

function maskPhoneTail(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length <= 4) return '****'
  return `…${d.slice(-4)}`
}

function contactDisplayName(cliente) {
  const nome = String(cliente?.nome || cliente?.pushname || '').trim()
  return nome || (cliente?.id ? `Cliente ${cliente.id}` : '')
}

async function resolveAdminAlertDestination(company_id, alert) {
  const clienteId = Number(alert?.cliente_id)
  if (Number.isInteger(clienteId) && clienteId > 0) {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, pushname')
      .eq('company_id', company_id)
      .eq('id', clienteId)
      .maybeSingle()

    if (error) {
      console.warn('[adminAtendimentoAlerta] destino cliente lookup:', error.message)
      return { ok: false, reason: 'contact_lookup_failed', error: error.message, cliente_id: clienteId }
    }
    if (!data) {
      return { ok: false, reason: 'contact_not_found', cliente_id: clienteId }
    }

    const telefone = String(data.telefone || data.wa_id || '').trim()
    const digits = telefone.replace(/\D/g, '')
    if (!digits || digits.length < 10) {
      return {
        ok: false,
        reason: 'invalid_contact_phone',
        cliente_id: clienteId,
        cliente_nome: contactDisplayName(data),
        digits,
      }
    }

    return {
      ok: true,
      source: 'cliente',
      telefone,
      digits,
      cliente_id: clienteId,
      cliente_nome: contactDisplayName(data),
    }
  }

  const telefone = String(alert?.telefone_admin || '').trim()
  const digits = telefone.replace(/\D/g, '')
  if (!digits || digits.length < 10) {
    return { ok: false, reason: 'invalid_phone', source: 'manual', digits }
  }
  return { ok: true, source: 'manual', telefone, digits, cliente_id: null, cliente_nome: '' }
}

function formatNotaPt(n) {
  if (n == null || !Number.isFinite(Number(n))) return null
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

async function fetchNotaMedia30d(company_id) {
  const since = new Date(Date.now() - AVALIACOES_LOOKBACK_MS).toISOString()
  const { data, error } = await supabase
    .from('avaliacoes_atendimento')
    .select('nota')
    .eq('company_id', company_id)
    .gte('criado_em', since)
    .limit(8000)

  if (error) {
    if (String(error.code || '') === '42P01') return null
    console.warn('[adminAtendimentoAlerta] fetchNotaMedia30d:', error.message)
    return null
  }
  const nums = (data || []).map((r) => Number(r.nota)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 10)
  if (!nums.length) return null
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  return Number(avg.toFixed(2))
}

/**
 * Bloqueia reenvio só quando já houve sucesso no dia. Falhas anteriores permitem nova tentativa na janela.
 */
async function acquireAlertaSendLock(company_id, diaLocalStr, horarioConfig) {
  const { data: existing, error: selErr } = await supabase
    .from('admin_atendimento_alerta_envios')
    .select('sucesso')
    .eq('company_id', company_id)
    .eq('dia_local', diaLocalStr)
    .maybeSingle()

  if (selErr) {
    if (String(selErr.code || '') === '42P01') {
      console.warn('[adminAtendimentoAlerta] tabela admin_atendimento_alerta_envios ausente — rode a migration')
    } else {
      console.warn('[adminAtendimentoAlerta] acquireAlertaSendLock select:', selErr.message)
    }
    return { ok: false, reason: 'db_error' }
  }

  if (existing?.sucesso === true) {
    return { ok: false, reason: 'already_sent' }
  }

  if (existing) {
    const { error: updErr } = await supabase
      .from('admin_atendimento_alerta_envios')
      .update({
        horario_config: horarioConfig,
        sucesso: false,
        detalhes: { reservado: true, retry: true },
      })
      .eq('company_id', company_id)
      .eq('dia_local', diaLocalStr)
    if (updErr) {
      console.warn('[adminAtendimentoAlerta] acquireAlertaSendLock retry update:', updErr.message)
      return { ok: false, reason: 'db_error' }
    }
    return { ok: true, retry: true }
  }

  const { error: insErr } = await supabase.from('admin_atendimento_alerta_envios').insert({
    company_id,
    dia_local: diaLocalStr,
    horario_config: horarioConfig,
    sucesso: false,
    detalhes: { reservado: true },
  })
  if (!insErr) return { ok: true }
  const code = String(insErr.code || '')
  const msg = String(insErr.message || '')
  if (code === '23505' || msg.includes('duplicate key')) {
    const { data: raced } = await supabase
      .from('admin_atendimento_alerta_envios')
      .select('sucesso')
      .eq('company_id', company_id)
      .eq('dia_local', diaLocalStr)
      .maybeSingle()
    if (raced?.sucesso === true) return { ok: false, reason: 'already_sent' }
    return { ok: true, retry: true }
  }
  console.warn('[adminAtendimentoAlerta] acquireAlertaSendLock insert:', insErr.message)
  return { ok: false, reason: 'db_error' }
}

async function inspectAlertaSendLock(company_id, diaLocalStr) {
  const { data, error } = await supabase
    .from('admin_atendimento_alerta_envios')
    .select('sucesso, horario_config, destino_suffix, detalhes, criado_em')
    .eq('company_id', company_id)
    .eq('dia_local', diaLocalStr)
    .maybeSingle()

  if (error) {
    if (String(error.code || '') === '42P01') return { ok: false, reason: 'table_missing' }
    return { ok: false, reason: 'db_error', error: error.message }
  }
  if (!data) return { ok: true, exists: false }
  return {
    ok: true,
    exists: true,
    sucesso: data.sucesso === true,
    horario_config: data.horario_config || '',
    destino_suffix: data.destino_suffix || null,
    detalhes: data.detalhes || {},
    criado_em: data.criado_em || null,
  }
}

async function finalizeAlertaSlot(company_id, diaLocalStr, payload) {
  const { error } = await supabase
    .from('admin_atendimento_alerta_envios')
    .update({
      sucesso: !!payload.sucesso,
      destino_suffix: payload.destino_suffix || null,
      detalhes: typeof payload.detalhes === 'object' ? payload.detalhes : {},
    })
    .eq('company_id', company_id)
    .eq('dia_local', diaLocalStr)
  if (error) console.warn('[adminAtendimentoAlerta] finalizeAlertaSlot:', error.message)
}

async function recordEnvio(company_id, diaLocalStr, horarioConfig, payload) {
  const { error } = await supabase.from('admin_atendimento_alerta_envios').insert({
    company_id,
    dia_local: diaLocalStr,
    horario_config: horarioConfig,
    sucesso: !!payload.sucesso,
    destino_suffix: payload.destino_suffix || null,
    detalhes: typeof payload.detalhes === 'object' ? payload.detalhes : {},
  })
  if (error) console.warn('[adminAtendimentoAlerta] recordEnvio:', error.message)
}

async function logBotAdminAlert(company_id, detalhes) {
  try {
    await supabase.from('bot_logs').insert({
      company_id,
      conversa_id: null,
      tipo: 'admin_alerta_atendimento',
      detalhes: typeof detalhes === 'object' ? detalhes : { raw: detalhes },
    })
  } catch (e) {
    console.warn('[adminAtendimentoAlerta] logBotAdminAlert:', e?.message || e)
  }
}

function buildMessage({ incluirNota, notaMedia, incluirSemResp, qtdSemResp, filaItens }) {
  const lines = ['📊 Resumo do atendimento:']
  if (incluirNota) {
    const txt = notaMedia != null ? formatNotaPt(notaMedia) : null
    lines.push(txt != null ? `Nota média dos atendimentos: ${txt}` : 'Nota média dos atendimentos: —')
  }
  if (incluirSemResp) {
    const qtd = Number.isFinite(Number(qtdSemResp)) ? Number(qtdSemResp) : 0
    lines.push(`Conversas aguardando resposta: ${qtd}`)
    const itens = Array.isArray(filaItens) ? filaItens : []
    if (itens.length > 0) {
      lines.push('')
      lines.push('Aguardando funcionário:')
      for (const item of itens) {
        const nome = String(item?.cliente_nome || item?.nome || 'Cliente').trim().slice(0, 80) || 'Cliente'
        const tel = String(item?.telefone || '').replace(/\D/g, '')
        const tail = tel.length >= 4 ? tel.slice(-4) : ''
        lines.push(tail ? `• ${nome} (…${tail})` : `• ${nome}`)
      }
      if (qtd > itens.length) {
        lines.push(`… e mais ${qtd - itens.length}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Processa envio para uma empresa (chamado pelo job de cron).
 * @returns {Promise<{ sent: boolean, reason?: string, error?: string }>}
 */
async function processCompanyAdminAlert({ company_id, fullConfig, provider, dryRun = false }) {
  const alert = normalizeAdminAtendimentoAlerta((fullConfig || {}).admin_atendimento_alerta || {})
  if (!alert.ativo) return { sent: false, reason: 'inactive' }

  const tz = resolveTimezone(alert, fullConfig)
  const now = new Date()
  const { ymd: diaLocal, hm: nowHm } = zonedYmdHm(now, tz)
  const scheduled = normalizeHorarioEnvio(alert.horario_envio)
  const withinWindow = isWithinDispatchWindow(scheduled, nowHm, CRON_GRACE_MINUTES)
  const baseDiag = {
    dryRun,
    scheduled,
    nowHm,
    timezone: tz,
    diaLocal,
    graceMinutes: CRON_GRACE_MINUTES,
    withinWindow,
    metricas: {
      incluir_nota_media: alert.incluir_nota_media,
      incluir_conversas_sem_resposta: alert.incluir_conversas_sem_resposta,
    },
    cliente_id: alert.cliente_id,
    cliente_nome: alert.cliente_nome,
    telefone_tail: maskPhoneTail(alert.telefone_admin),
  }

  if (!withinWindow) {
    if (String(process.env.ADMIN_ATENDIMENTO_ALERTA_DEBUG || '').trim() === '1') {
      console.log('[adminAtendimentoAlerta] fora da janela', {
        company_id,
        scheduled,
        nowHm,
        tz,
        diaLocal,
        graceMin: CRON_GRACE_MINUTES,
      })
    }
    return { sent: false, reason: 'outside_window', ...baseDiag }
  }

  if (!alert.incluir_nota_media && !alert.incluir_conversas_sem_resposta) {
    return { sent: false, reason: 'no_metrics_enabled', ...baseDiag }
  }

  const destination = await resolveAdminAlertDestination(company_id, alert)
  const destinationDiag = {
    ...baseDiag,
    destino_origem: destination.source || (alert.cliente_id ? 'cliente' : 'manual'),
    cliente_id: destination.cliente_id ?? alert.cliente_id,
    cliente_nome: destination.cliente_nome || alert.cliente_nome,
    telefone_tail: maskPhoneTail(destination.digits || alert.telefone_admin),
  }
  const digits = destination.digits || ''
  if (!destination.ok) {
    await logBotAdminAlert(company_id, {
      ok: false,
      dia_local: diaLocal,
      horario: scheduled,
      cliente_id: destination.cliente_id ?? alert.cliente_id,
      cliente_nome: destination.cliente_nome || alert.cliente_nome,
      erro: destination.reason || 'destino inválido',
    })
    console.warn('[adminAtendimentoAlerta] destino inválido', {
      company_id,
      reason: destination.reason,
      cliente_id: destination.cliente_id ?? alert.cliente_id,
    })
    return { sent: false, reason: destination.reason || 'invalid_destination', error: destination.error, ...destinationDiag }
  }

  const send = provider?.sendText
  if (!dryRun && typeof send !== 'function') {
    await logBotAdminAlert(company_id, { ok: false, dia_local: diaLocal, erro: 'sendText indisponível' })
    return { sent: false, reason: 'no_provider', ...destinationDiag }
  }

  if (dryRun) {
    const lock = await inspectAlertaSendLock(company_id, diaLocal)
    let notaMedia = null
    let qtdSemResp = 0
    let filaItens = []
    if (alert.incluir_nota_media) {
      notaMedia = await fetchNotaMedia30d(company_id)
    }
    if (alert.incluir_conversas_sem_resposta) {
      try {
        const chatbotEnabled = isChatbotTriageEnabled(fullConfig?.chatbot_triage)
        const fila = await getAguardandoFuncionarioParaAlertaAdmin(company_id, {
          chatbotEnabled,
          limit: 15,
        })
        qtdSemResp = fila.count
        filaItens = fila.items
      } catch (_) {
        qtdSemResp = 0
        filaItens = []
      }
    }
    return {
      sent: false,
      reason: lock?.sucesso ? 'already_sent_today' : 'dry_run_ready',
      ...destinationDiag,
      lock,
      preview: {
        nota_media: notaMedia,
        conversas_sem_resposta: alert.incluir_conversas_sem_resposta ? qtdSemResp : undefined,
        itens: filaItens,
      },
    }
  }

  const locked = await acquireAlertaSendLock(company_id, diaLocal, scheduled)
  if (!locked.ok) {
    const reason = locked.reason === 'already_sent' ? 'already_sent_today' : 'reserve_failed'
    if (reason === 'reserve_failed') {
      console.warn('[adminAtendimentoAlerta] falha ao reservar envio (ver tabela/migração)', {
        company_id,
        dia_local: diaLocal,
        lock_reason: locked.reason,
      })
    }
    return { sent: false, reason, lock_reason: locked.reason, ...destinationDiag }
  }

  let notaMedia = null
  let qtdSemResp = 0
  let filaItens = []
  let result = { ok: false, error: null }

  try {
    if (alert.incluir_nota_media) {
      notaMedia = await fetchNotaMedia30d(company_id)
    }

    if (alert.incluir_conversas_sem_resposta) {
      try {
        const chatbotEnabled = isChatbotTriageEnabled(fullConfig?.chatbot_triage)
        const fila = await getAguardandoFuncionarioParaAlertaAdmin(company_id, {
          chatbotEnabled,
          limit: 15,
        })
        qtdSemResp = fila.count
        filaItens = fila.items
      } catch (eCount) {
        console.warn('[adminAtendimentoAlerta] count conversas sem resposta (usa 0):', company_id, eCount?.message || eCount)
        qtdSemResp = 0
        filaItens = []
      }
    }

    const texto = buildMessage({
      incluirNota: alert.incluir_nota_media,
      notaMedia,
      incluirSemResp: alert.incluir_conversas_sem_resposta,
      qtdSemResp,
      filaItens,
    })

    result = (await send(destination.telefone, texto, { companyId: company_id })) || { ok: false }
  } catch (e) {
    result = { ok: false, error: String(e?.message || e || 'exceção no envio') }
    console.warn('[adminAtendimentoAlerta] exceção após reserva', { company_id, erro: result.error })
  }

  const ok = !!result?.ok

  await finalizeAlertaSlot(company_id, diaLocal, {
    sucesso: ok,
    destino_suffix: maskPhoneTail(digits),
    detalhes: {
      reservado: false,
      destino_origem: destination.source,
      cliente_id: destination.cliente_id,
      cliente_nome: destination.cliente_nome,
      nota_media: notaMedia,
      conversas_sem_resposta: alert.incluir_conversas_sem_resposta ? qtdSemResp : undefined,
      ultramsg_error: ok ? null : (result?.error || null),
    },
  })

  await logBotAdminAlert(company_id, {
    ok,
    dia_local: diaLocal,
    horario: scheduled,
    timezone: tz,
    now_hm: nowHm,
    destino_origem: destination.source,
    cliente_id: destination.cliente_id,
    cliente_nome: destination.cliente_nome,
    destino_mascarado: maskPhoneTail(digits),
    nota_media: notaMedia,
    conversas_sem_resposta: alert.incluir_conversas_sem_resposta ? qtdSemResp : undefined,
    erro: ok ? null : (result?.error || null),
  })

  if (ok) {
    console.log('[adminAtendimentoAlerta] enviado', { company_id, dia_local: diaLocal, destino: maskPhoneTail(digits) })
    return { sent: true, ...destinationDiag }
  }
  console.warn('[adminAtendimentoAlerta] falha UltraMsg', { company_id, erro: result?.error })
  return { sent: false, reason: 'send_failed', error: result?.error, ...destinationDiag }
}

function parseIaConfigJson(config) {
  if (config == null) return {}
  if (typeof config === 'string') {
    try {
      const o = JSON.parse(config)
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  return typeof config === 'object' ? config : {}
}

/**
 * Varre todas as empresas com ia_config (uso pelo POST /jobs e pelo scheduler interno).
 */
async function runAdminAtendimentoAlertaForAllCompanies(opts = {}) {
  const dryRun = opts.dryRun === true
  const { data: rows, error } = await supabase.from('ia_config').select('company_id, config')
  if (error) {
    console.warn('[adminAtendimentoAlertaJob] select ia_config:', error.message)
    return { ok: false, processadas: 0, enviadas: 0, detalhes: [], error: error.message }
  }
  if (!rows?.length) {
    return { ok: true, processadas: 0, enviadas: 0, detalhes: [], mensagem: 'Nenhuma empresa com ia_config' }
  }

  const { getProvider } = require('./providers')
  const provider = getProvider()

  let processadas = 0
  let enviadas = 0
  const detalhes = []

  for (const row of rows) {
    const company_id = row.company_id
    const cfg = parseIaConfigJson(row.config)
    const alertNorm = normalizeAdminAtendimentoAlerta(cfg.admin_atendimento_alerta || {})
    if (!alertNorm.ativo) continue

    processadas++
    const r = await processCompanyAdminAlert({
      company_id,
      fullConfig: cfg,
      provider,
      dryRun,
    })
    detalhes.push({ company_id, ...r })
    if (r?.sent) enviadas++
  }

  return { ok: true, processadas, enviadas, detalhes }
}

module.exports = {
  DEFAULT_ADMIN_ATENDIMENTO_ALERTA,
  normalizeAdminAtendimentoAlerta,
  processCompanyAdminAlert,
  runAdminAtendimentoAlertaForAllCompanies,
  parseIaConfigJson,
}
