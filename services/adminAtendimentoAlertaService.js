/**
 * Alerta diário (cron) com resumo de atendimento para número do administrador — config em ia_config.config.admin_atendimento_alerta.
 * Idempotência: tabela admin_atendimento_alerta_envios (company_id + dia_local).
 */

const supabase = require('../config/supabase')
const { countAguardandoFuncionarioParaAlertaAdmin } = require('./supervisaoService')

const CRON_GRACE_MINUTES = 6
const AVALIACOES_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

const DEFAULT_ADMIN_ATENDIMENTO_ALERTA = {
  ativo: false,
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

function normalizeAdminAtendimentoAlerta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const tz = String(r.timezone || '').trim()
  return {
    ativo: r.ativo === true,
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
  const g = (t) => dp.find((p) => p.type === t)?.value || '00'
  return {
    ymd: `${g('year')}-${g('month')}-${g('day')}`,
    hm: `${g('hour')}:${g('minute')}`,
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
  return t1 >= t0 && t1 < t0 + graceMinutes
}

function maskPhoneTail(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length <= 4) return '****'
  return `…${d.slice(-4)}`
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

async function tryReserveAlertaSlot(company_id, diaLocalStr, horarioConfig) {
  const { error } = await supabase.from('admin_atendimento_alerta_envios').insert({
    company_id,
    dia_local: diaLocalStr,
    horario_config: horarioConfig,
    sucesso: false,
    detalhes: { reservado: true },
  })
  if (!error) return { ok: true }
  const code = String(error.code || '')
  const msg = String(error.message || '')
  if (code === '23505' || msg.includes('duplicate key')) return { ok: false, reason: 'duplicate' }
  console.warn('[adminAtendimentoAlerta] tryReserveAlertaSlot:', error.message)
  return { ok: false, reason: 'db_error' }
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

function buildMessage({ incluirNota, notaMedia, incluirSemResp, qtdSemResp }) {
  const lines = ['📊 Resumo do atendimento:']
  if (incluirNota) {
    const txt = notaMedia != null ? formatNotaPt(notaMedia) : null
    lines.push(txt != null ? `Nota média dos atendimentos: ${txt}` : 'Nota média dos atendimentos: —')
  }
  if (incluirSemResp) {
    lines.push(`Conversas aguardando resposta: ${Number.isFinite(Number(qtdSemResp)) ? Number(qtdSemResp) : 0}`)
  }
  return lines.join('\n')
}

/**
 * Processa envio para uma empresa (chamado pelo job de cron).
 * @returns {Promise<{ sent: boolean, reason?: string, error?: string }>}
 */
async function processCompanyAdminAlert({ company_id, fullConfig, provider }) {
  const alert = normalizeAdminAtendimentoAlerta((fullConfig || {}).admin_atendimento_alerta || {})
  if (!alert.ativo) return { sent: false, reason: 'inactive' }

  const tz = resolveTimezone(alert, fullConfig)
  const now = new Date()
  const { ymd: diaLocal, hm: nowHm } = zonedYmdHm(now, tz)
  const scheduled = normalizeHorarioEnvio(alert.horario_envio)

  if (!isWithinDispatchWindow(scheduled, nowHm, CRON_GRACE_MINUTES)) {
    return { sent: false, reason: 'outside_window' }
  }

  if (!alert.incluir_nota_media && !alert.incluir_conversas_sem_resposta) {
    return { sent: false, reason: 'no_metrics_enabled' }
  }

  const digits = String(alert.telefone_admin || '').replace(/\D/g, '')
  if (!digits || digits.length < 10) {
    await recordEnvio(company_id, diaLocal, scheduled, {
      sucesso: false,
      destino_suffix: maskPhoneTail(digits),
      detalhes: { erro: 'telefone_admin inválido' },
    })
    await logBotAdminAlert(company_id, {
      ok: false,
      dia_local: diaLocal,
      horario: scheduled,
      erro: 'telefone_admin inválido',
    })
    console.warn('[adminAtendimentoAlerta] telefone inválido', { company_id })
    return { sent: false, reason: 'invalid_phone' }
  }

  const send = provider?.sendText
  if (typeof send !== 'function') {
    await recordEnvio(company_id, diaLocal, scheduled, {
      sucesso: false,
      destino_suffix: maskPhoneTail(digits),
      detalhes: { erro: 'provider.sendText indisponível' },
    })
    await logBotAdminAlert(company_id, { ok: false, dia_local: diaLocal, erro: 'sendText indisponível' })
    return { sent: false, reason: 'no_provider' }
  }

  const reserved = await tryReserveAlertaSlot(company_id, diaLocal, scheduled)
  if (!reserved.ok) {
    return { sent: false, reason: 'already_sent_or_attempted' }
  }

  let notaMedia = null
  if (alert.incluir_nota_media) {
    notaMedia = await fetchNotaMedia30d(company_id)
  }

  let qtdSemResp = 0
  if (alert.incluir_conversas_sem_resposta) {
    const chatbotEnabled = !!(fullConfig?.chatbot_triage && fullConfig.chatbot_triage.enabled === true)
    qtdSemResp = await countAguardandoFuncionarioParaAlertaAdmin(company_id, { chatbotEnabled })
  }

  const texto = buildMessage({
    incluirNota: alert.incluir_nota_media,
    notaMedia,
    incluirSemResp: alert.incluir_conversas_sem_resposta,
    qtdSemResp,
  })

  let result = { ok: false, error: null }
  try {
    result = (await send(alert.telefone_admin, texto, { companyId: company_id })) || { ok: false }
  } catch (e) {
    result = { ok: false, error: String(e?.message || e || 'exceção no envio') }
  }
  const ok = !!result?.ok

  await finalizeAlertaSlot(company_id, diaLocal, {
    sucesso: ok,
    destino_suffix: maskPhoneTail(digits),
    detalhes: {
      reservado: false,
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
    destino_mascarado: maskPhoneTail(digits),
    nota_media: notaMedia,
    conversas_sem_resposta: alert.incluir_conversas_sem_resposta ? qtdSemResp : undefined,
    erro: ok ? null : (result?.error || null),
  })

  if (ok) {
    console.log('[adminAtendimentoAlerta] enviado', { company_id, dia_local: diaLocal, destino: maskPhoneTail(digits) })
    return { sent: true }
  }
  console.warn('[adminAtendimentoAlerta] falha UltraMsg', { company_id, erro: result?.error })
  return { sent: false, reason: 'send_failed', error: result?.error }
}

module.exports = {
  DEFAULT_ADMIN_ATENDIMENTO_ALERTA,
  normalizeAdminAtendimentoAlerta,
  processCompanyAdminAlert,
}
