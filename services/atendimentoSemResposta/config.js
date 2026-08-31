const supabase = require('../../config/supabase')
const { DEFAULT_ALERTA_SEM_RESPOSTA } = require('./constants')
const {
  normalizeHorarioTime,
  normalizeDiasSemanaDesativados,
  normalizeDatasEspecificasFechadas,
  mergeScheduleSource,
  normalizeBusinessSchedule,
  formatScheduleTime,
  describeBusinessSchedule,
} = require('../../helpers/businessSchedule')

function coerceAtivo(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())) return true
  return false
}

function normalizeMinutes(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(1440, Math.floor(n)))
}

function validateMinuteValue(value, label) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return `${label} precisa ser um número positivo.`
  }
  if (n > 1440) {
    return `${label} não pode passar de 1440 minutos.`
  }
  return null
}

/** Com alerta ativo, horario comercial e sempre obrigatorio (nunca conta 24h). */
function resolveAlertaRuntimeConfig(cfg = {}) {
  if (!cfg.alerta_sem_resposta_ativo) return cfg
  return { ...cfg, horario_comercial_ativo: true }
}

function normalizeAlertaSemResposta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const gestorId = Number(r.gestor_notificado_id)
  const gestorClienteId = Number(r.gestor_cliente_id)
  const responsaveis = Array.isArray(r.responsaveis_notificacao_ids)
    ? r.responsaveis_notificacao_ids.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : []
  const alertaAtivo = coerceAtivo(r.alerta_sem_resposta_ativo) || coerceAtivo(r.ativo)
  const scheduleKeys = ['horarioInicio', 'horarioFim', 'horariosJanelas', 'diasSemanaDesativados', 'datasEspecificasFechadas']
  const hasScheduleInput = scheduleKeys.some((key) => Object.prototype.hasOwnProperty.call(r, key))
  const base = {
    ...DEFAULT_ALERTA_SEM_RESPOSTA,
    alerta_sem_resposta_ativo: alertaAtivo,
    tempo_primeiro_alerta_minutos: normalizeMinutes(r.tempo_primeiro_alerta_minutos, 1),
    tempo_alerta_critico_minutos: normalizeMinutes(r.tempo_alerta_critico_minutos, 3),
    tempo_notificar_gestor_minutos: normalizeMinutes(r.tempo_notificar_gestor_minutos, 5),
    notificar_por_whatsapp: r.notificar_por_whatsapp === true,
    notificar_por_email: r.notificar_por_email === true,
    notificar_interno: r.notificar_interno !== false,
    reabrir_conversa_automaticamente: r.reabrir_conversa_automaticamente !== false,
    aplicar_tag_automatica: r.aplicar_tag_automatica !== false,
    nome_tag_automatica: String(r.nome_tag_automatica || DEFAULT_ALERTA_SEM_RESPOSTA.nome_tag_automatica).trim().slice(0, 120),
    gestor_notificado_id: Number.isInteger(gestorId) && gestorId > 0 ? gestorId : null,
    gestor_cliente_id: Number.isInteger(gestorClienteId) && gestorClienteId > 0 ? gestorClienteId : null,
    gestor_cliente_nome: String(r.gestor_cliente_nome || '').trim().slice(0, 120),
    responsaveis_notificacao_ids: responsaveis,
    telefone_gestor: String(r.telefone_gestor || '').trim().slice(0, 40),
    horario_comercial_ativo: alertaAtivo ? true : r.horario_comercial_ativo !== false,
    timezone: String(r.timezone || DEFAULT_ALERTA_SEM_RESPOSTA.timezone).trim().slice(0, 80) || 'America/Sao_Paulo',
  }
  if (!hasScheduleInput) return base
  return {
    ...base,
    horarioInicio: normalizeHorarioTime(r.horarioInicio, '09:00'),
    horarioFim: normalizeHorarioTime(r.horarioFim, '18:00'),
    diasSemanaDesativados: normalizeDiasSemanaDesativados(r.diasSemanaDesativados),
    datasEspecificasFechadas: normalizeDatasEspecificasFechadas(r.datasEspecificasFechadas),
  }
}

function validateAlertaSemResposta(cfg) {
  const minuteFields = [
    ['tempo_primeiro_alerta_minutos', 'O primeiro alerta'],
    ['tempo_alerta_critico_minutos', 'O alerta crítico'],
    ['tempo_notificar_gestor_minutos', 'A notificação ao gestor'],
  ]
  for (const [field, label] of minuteFields) {
    const err = validateMinuteValue(cfg?.[field], label)
    if (err) return err
  }

  const c = normalizeAlertaSemResposta(cfg)
  if (c.tempo_alerta_critico_minutos < c.tempo_primeiro_alerta_minutos) {
    return 'O alerta crítico precisa ser maior que o primeiro alerta.'
  }
  if (c.tempo_notificar_gestor_minutos < c.tempo_alerta_critico_minutos) {
    return 'A notificação ao gestor precisa ser maior que o alerta crítico.'
  }
  if (c.aplicar_tag_automatica && !c.nome_tag_automatica) {
    return 'Informe o nome da tag automática.'
  }
  if (!c.alerta_sem_resposta_ativo) {
    return null
  }
  if (c.notificar_por_whatsapp) {
    const clienteId = Number(c.gestor_cliente_id)
    const manual = String(c.telefone_gestor || '').replace(/\D/g, '')
    const hasCliente = Number.isInteger(clienteId) && clienteId > 0
    if (!hasCliente && (!manual || manual.length < 10)) {
      return 'Para WhatsApp, selecione um contato cadastrado no sistema.'
    }
  }
  if (!c.notificar_por_whatsapp && !c.notificar_por_email && !c.notificar_interno) {
    return 'Selecione ao menos um canal de notificação.'
  }
  return null
}

function hasSmtpConfig() {
  return Boolean(
    String(process.env.SMTP_HOST || '').trim() ||
      String(process.env.SMTP_URL || '').trim() ||
      String(process.env.MAIL_HOST || '').trim()
  )
}

async function validateAlertaSemRespostaReferences(company_id, cfg) {
  if (!cfg.alerta_sem_resposta_ativo) return null

  if (cfg.notificar_por_email) {
    if (!hasSmtpConfig()) {
      return 'E-mail indisponivel: configure SMTP antes de ativar este canal.'
    }
  }

  if (cfg.notificar_interno || cfg.notificar_por_email) {
    const gestorId = Number(cfg.gestor_notificado_id)
    if (!Number.isInteger(gestorId) || gestorId <= 0) {
      return 'Selecione um responsavel interno da empresa.'
    }
    const { data, error } = await supabase
      .from('usuarios')
      .select('id')
      .eq('company_id', company_id)
      .eq('id', gestorId)
      .maybeSingle()
    if (error) return error.message
    if (!data?.id) return 'Responsavel interno invalido para esta empresa.'
  }

  if (cfg.notificar_por_whatsapp) {
    const clienteId = Number(cfg.gestor_cliente_id)
    if (Number.isInteger(clienteId) && clienteId > 0) {
      const { data, error } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', company_id)
        .eq('id', clienteId)
        .maybeSingle()
      if (error) return error.message
      if (!data?.id) return 'Contato WhatsApp do gestor invalido para esta empresa.'
    }
  }

  return null
}

async function loadIaConfig(company_id) {
  const { data, error } = await supabase
    .from('ia_config')
    .select('config')
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.config && typeof data.config === 'object' ? data.config : {}
}

async function getAlertaSemRespostaConfig(company_id) {
  const config = await loadIaConfig(company_id)
  return normalizeAlertaSemResposta(config.alerta_sem_resposta || {})
}

async function loadBusinessSchedule(company_id, cfg) {
  const effectiveCfg = resolveAlertaRuntimeConfig(cfg)
  if (!effectiveCfg.horario_comercial_ativo) return normalizeBusinessSchedule(effectiveCfg, {})
  const full = await loadIaConfig(company_id)
  return normalizeBusinessSchedule(effectiveCfg, full)
}

async function getBusinessScheduleInfo(company_id, cfg = null) {
  const alertaCfg = resolveAlertaRuntimeConfig(cfg || await getAlertaSemRespostaConfig(company_id))
  const schedule = await loadBusinessSchedule(company_id, alertaCfg)
  return {
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    dias_semana_desativados: schedule.diasSemanaDesativados || [],
    datas_especificas_fechadas: schedule.datasEspecificasFechadas || [],
    janelas: (schedule.windows || []).map((w) => ({
      inicio: formatScheduleTime(w.start),
      fim: formatScheduleTime(w.end),
    })),
    resumo: describeBusinessSchedule(schedule),
  }
}

async function getAlertaSemRespostaConfigForApi(company_id) {
  const saved = await loadIaConfig(company_id)
  const raw = saved.alerta_sem_resposta && typeof saved.alerta_sem_resposta === 'object'
    ? saved.alerta_sem_resposta
    : {}
  const config = normalizeAlertaSemResposta(raw)
  const ct = saved.chatbot_triage && typeof saved.chatbot_triage === 'object' ? saved.chatbot_triage : {}
  const merged = mergeScheduleSource(config, ct)
  const horarioComercial = await getBusinessScheduleInfo(company_id, config)
  return {
    ...config,
    horarioInicio: merged.horarioInicio,
    horarioFim: merged.horarioFim,
    diasSemanaDesativados: merged.diasSemanaDesativados,
    datasEspecificasFechadas: merged.datasEspecificasFechadas,
    horario_comercial: horarioComercial,
  }
}

async function saveAlertaSemRespostaConfig(company_id, patch) {
  const err = validateAlertaSemResposta({ ...(await getAlertaSemRespostaConfig(company_id)), ...(patch || {}) })
  if (err) return { ok: false, error: err }

  const current = await loadIaConfig(company_id)
  const merged = normalizeAlertaSemResposta({
    ...(current.alerta_sem_resposta || {}),
    ...(patch || {}),
  })
  const refErr = await validateAlertaSemRespostaReferences(company_id, merged)
  if (refErr) return { ok: false, error: refErr }

  const nextConfig = { ...current, alerta_sem_resposta: merged }
  const { error } = await supabase
    .from('ia_config')
    .upsert(
      { company_id, config: nextConfig, updated_at: new Date().toISOString() },
      { onConflict: 'company_id' }
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true, config: merged }
}

module.exports = {
  DEFAULT_ALERTA_SEM_RESPOSTA,
  resolveAlertaRuntimeConfig,
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  hasSmtpConfig,
  loadIaConfig,
  getAlertaSemRespostaConfig,
  loadBusinessSchedule,
  getBusinessScheduleInfo,
  getAlertaSemRespostaConfigForApi,
  saveAlertaSemRespostaConfig,
}
