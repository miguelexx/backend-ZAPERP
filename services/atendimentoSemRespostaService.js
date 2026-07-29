/**
 * Alertas de atendimento sem resposta — config em ia_config.config.alerta_sem_resposta.
 * Eventos: alerta_atendimento_sem_resposta_eventos
 * Estado/idempotência por conversa: alerta_atendimento_sem_resposta_estado
 */

const supabase = require('../config/supabase')
const { REAL_MESSAGE_DIRECOES } = require('../helpers/internalNote')
const {
  markReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../helpers/reabertaFaltaInteracaoHelper')

const DEFAULT_ALERTA_SEM_RESPOSTA = {
  alerta_sem_resposta_ativo: false,
  tempo_primeiro_alerta_minutos: 1,
  tempo_alerta_critico_minutos: 3,
  tempo_notificar_gestor_minutos: 5,
  notificar_por_whatsapp: false,
  notificar_por_email: false,
  notificar_interno: true,
  reabrir_conversa_automaticamente: true,
  aplicar_tag_automatica: true,
  nome_tag_automatica: 'Reaberta por falta de resposta',
  gestor_notificado_id: null,
  gestor_cliente_id: null,
  gestor_cliente_nome: '',
  responsaveis_notificacao_ids: [],
  telefone_gestor: '',
  horario_comercial_ativo: true,
  timezone: 'America/Sao_Paulo',
}

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

function normalizeHorarioTime(value, fallback = '09:00') {
  const raw = String(value || '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)))
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function normalizeDiasSemanaDesativados(value, fallback = [0, 6]) {
  if (!Array.isArray(value)) return fallback
  const days = [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  return days.length ? days : fallback
}

function normalizeDatasEspecificasFechadas(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .map((d) => String(d || '').trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  )].sort()
}

function alertConfigHasOwnSchedule(cfg = {}) {
  return ['horarioInicio', 'horarioFim', 'horariosJanelas', 'diasSemanaDesativados', 'datasEspecificasFechadas']
    .some((key) => Object.prototype.hasOwnProperty.call(cfg, key))
}

function mergeScheduleSource(cfg = {}, ct = {}) {
  const src = alertConfigHasOwnSchedule(cfg) ? cfg : ct
  return {
    horarioInicio: src.horarioInicio || '09:00',
    horarioFim: src.horarioFim || '18:00',
    horariosJanelas: Array.isArray(src.horariosJanelas) ? src.horariosJanelas : [],
    diasSemanaDesativados: normalizeDiasSemanaDesativados(src.diasSemanaDesativados),
    datasEspecificasFechadas: normalizeDatasEspecificasFechadas(src.datasEspecificasFechadas),
  }
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

async function resolveGestorEmailDestination(company_id, cfg) {
  const gestorId = Number(cfg?.gestor_notificado_id)
  if (!Number.isInteger(gestorId) || gestorId <= 0) {
    return { ok: false, reason: 'gestor_notificado_nao_selecionado' }
  }

  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, email')
    .eq('company_id', company_id)
    .eq('id', gestorId)
    .maybeSingle()

  if (error) return { ok: false, reason: 'gestor_lookup_failed', error: error.message }
  if (!data) return { ok: false, reason: 'gestor_not_found' }

  const email = String(data.email || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: 'gestor_email_invalido', gestor_id: gestorId }
  }

  return {
    ok: true,
    gestor_id: gestorId,
    gestor_nome: String(data.nome || '').trim(),
    email,
  }
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

function isMissingTableError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('does not exist') ||
    msg.includes('relation') ||
    msg.includes('schema cache') ||
    msg.includes('permission denied')
  )
}

async function listAlertaSemRespostaEventos(company_id, { limit = 20, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 20))
  const off = Math.max(0, Number(offset) || 0)
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_eventos')
      .select('id, conversa_id, atendente_id, tipo, nivel, mensagem, metadata, criado_em')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .range(off, off + lim - 1)
    if (error) {
      if (isMissingTableError(error)) {
        if (String(error.message || '').toLowerCase().includes('permission denied')) {
          console.warn('[atendimentoSemResposta] permissão negada em eventos — aplique GRANT/migration 20260608130000')
        }
        return { ok: true, eventos: [] }
      }
      return { ok: false, error: error.message, eventos: [] }
    }
    const eventos = (data || []).map((e) => ({
      ...e,
      detalhes: e?.metadata && typeof e.metadata === 'object' ? e.metadata : {},
    }))
    return { ok: true, eventos }
  } catch (e) {
    if (isMissingTableError(e)) return { ok: true, eventos: [] }
    return { ok: false, error: e?.message || String(e), eventos: [] }
  }
}

async function recordEvento(company_id, row) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_eventos').insert({
      company_id,
      conversa_id: row.conversa_id,
      atendente_id: row.atendente_id ?? null,
      tipo: row.tipo,
      nivel: row.nivel ?? null,
      mensagem: row.mensagem ?? null,
      metadata: {
        ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        ...(row.detalhes && typeof row.detalhes === 'object' ? row.detalhes : {}),
      },
    })
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] recordEvento:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] recordEvento:', e?.message || e)
  }
}

async function getEstado(company_id, conversa_id) {
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .select('*')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error)) return null
      console.warn('[atendimentoSemResposta] getEstado:', error.message)
      return null
    }
    return data
  } catch (e) {
    return null
  }
}

async function upsertEstado(company_id, conversa_id, patch) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_estado').upsert(
      {
        company_id,
        conversa_id,
        ...patch,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'company_id,conversa_id' }
    )
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] upsertEstado:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] upsertEstado:', e?.message || e)
  }
}

async function clearEstado(company_id, conversa_id) {
  try {
    await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
  } catch (_) {}
}

function buildAlertaSemRespostaResetPatch(assumidaEm) {
  return {
    ultimo_cliente_msg_em: assumidaEm,
    primeiro_alerta_em: null,
    alerta_critico_em: null,
    gestor_notificado_em: null,
    reaberta_em: null,
  }
}

async function resetAlertaSemRespostaAoAssumirReaberta(
  company_id,
  conversa_id,
  assumidaEm = new Date().toISOString(),
  opts = {}
) {
  try {
    const estado = opts.estado != null ? opts.estado : await getEstado(company_id, conversa_id)
    let foiReabertaPeloAlerta = Boolean(estado?.reaberta_em)

    if (!foiReabertaPeloAlerta && opts.reaberta_falta_interacao_em) {
      foiReabertaPeloAlerta = true
    }

    if (!foiReabertaPeloAlerta) {
      const { data: conv } = await supabase
        .from('conversas')
        .select('reaberta_falta_interacao_em')
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .maybeSingle()
      foiReabertaPeloAlerta = Boolean(conv?.reaberta_falta_interacao_em)
    }

    if (!foiReabertaPeloAlerta) {
      return { ok: true, resetado: false, reason: 'nao_reaberta_pelo_alerta' }
    }

    await upsertEstado(company_id, conversa_id, buildAlertaSemRespostaResetPatch(assumidaEm))
    return { ok: true, resetado: true, ciclo_iniciado_em: assumidaEm }
  } catch (e) {
    console.warn('[atendimentoSemResposta] reset ao assumir reaberta:', e?.message || e)
    return { ok: false, resetado: false, error: e?.message || String(e) }
  }
}

async function fetchUltimaMensagem(company_id, conversa_id) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('id, conversa_id, criado_em, direcao, texto')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    // Nota interna não é interação com o cliente: não pode zerar/adiar o alerta de falta de resposta.
    .in('direcao', REAL_MESSAGE_DIRECOES)
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

async function revalidateConversaElegivel(company_id, conv, anchor) {
  const { data, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, status_atendimento, atendente_atribuido_em')
    .eq('company_id', company_id)
    .eq('id', conv.id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)
    .maybeSingle()
  if (error || !data?.id) return false
  if (Number(data.atendente_id) !== Number(conv.atendente_id)) return false

  const ultima = await fetchUltimaMensagem(company_id, conv.id)
  if (!ultima || ultima.direcao !== 'in') {
    await clearEstado(company_id, conv.id)
    return false
  }
  if (String(ultima.criado_em) === String(anchor)) return true

  const anchorMs = new Date(anchor).getTime()
  const ultimaMs = new Date(ultima.criado_em).getTime()
  const assumidaMs = new Date(data.atendente_atribuido_em || conv.atendente_atribuido_em || 0).getTime()
  return (
    Number.isFinite(anchorMs) &&
    Number.isFinite(ultimaMs) &&
    Number.isFinite(assumidaMs) &&
    anchorMs > ultimaMs &&
    Math.abs(anchorMs - assumidaMs) <= 60 * 1000
  )
}

function duplicateKeyError(error) {
  const msg = String(error?.message || '').toLowerCase()
  return error?.code === '23505' || msg.includes('duplicate key') || msg.includes('violates unique constraint')
}

async function claimEstadoStage(company_id, conversa_id, anchor, estadoPatch) {
  const stage = Object.keys(estadoPatch || {}).find((k) =>
    ['primeiro_alerta_em', 'alerta_critico_em', 'gestor_notificado_em'].includes(k)
  )
  if (!stage) return false

  const now = new Date().toISOString()
  const claimedAt = estadoPatch[stage] || now
  const patch = {
    ultimo_cliente_msg_em: anchor,
    [stage]: claimedAt,
    atualizado_em: now,
  }

  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .update(patch)
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('ultimo_cliente_msg_em', anchor)
      .is(stage, null)
      .select('conversa_id')
      .maybeSingle()

    if (error) {
      if (isMissingTableError(error)) return true
      console.warn('[atendimentoSemResposta] claimEstadoStage:', error.message)
      return false
    }
    if (data?.conversa_id) return true

    const { error: insertError } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .insert({
        company_id,
        conversa_id,
        ...patch,
      })
    if (!insertError) return true
    if (isMissingTableError(insertError)) return true
    if (duplicateKeyError(insertError)) return false
    console.warn('[atendimentoSemResposta] claimEstadoStage insert:', insertError.message)
    return false
  } catch (e) {
    if (isMissingTableError(e)) return true
    console.warn('[atendimentoSemResposta] claimEstadoStage:', e?.message || e)
    return false
  }
}

function emitAlertaRealtime(io, company_id, payload, opts = {}) {
  if (!io || !company_id || !payload?.conversa_id) return
  const base = {
    company_id: Number(company_id),
    conversa_id: Number(payload.conversa_id),
    atendente_id: payload.atendente_id != null ? Number(payload.atendente_id) : null,
    tipo: payload.tipo,
    nivel: payload.nivel || null,
    mensagem: payload.mensagem || null,
  }
  if (base.atendente_id) {
    io.to(`usuario_${base.atendente_id}`).emit('alerta_sem_resposta', base)
  }
  const gestorId = Number(opts.gestorId)
  if (Number.isFinite(gestorId) && gestorId > 0) {
    io.to(`usuario_${gestorId}`).emit('alerta_sem_resposta', base)
  }
  io.to(`empresa_${company_id}`).emit('alerta_sem_resposta_evento', base)
}

const TAG_REABERTA_FALTA_RESPOSTA_COR = '#2563eb'

async function fetchConversaTagsForRealtime(company_id, conversa_id) {
  const { data, error } = await supabase
    .from('conversa_tags')
    .select('tags ( id, nome, cor )')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
  if (error) {
    console.warn('[atendimentoSemResposta] fetchConversaTagsForRealtime:', error.message)
    return []
  }
  return (data || []).map((row) => row?.tags).filter(Boolean)
}

async function ensureTagForConversa(company_id, conversa_id, nomeTag) {
  const nome = String(nomeTag || '').trim()
  if (!nome) return null
  const { data: tag, error: tagLookupError } = await supabase
    .from('tags')
    .select('id, nome, cor')
    .eq('company_id', company_id)
    .ilike('nome', nome)
    .maybeSingle()
  if (tagLookupError) {
    console.warn('[atendimentoSemResposta] ensureTagForConversa lookup:', tagLookupError.message)
    return null
  }
  let tagId = tag?.id
  if (!tagId) {
    const { data: created, error: createError } = await supabase
      .from('tags')
      .insert({ company_id, nome, cor: TAG_REABERTA_FALTA_RESPOSTA_COR })
      .select('id')
      .single()
    tagId = created?.id
    if (!tagId && createError && duplicateKeyError(createError)) {
      const { data: afterRace } = await supabase
        .from('tags')
        .select('id, nome, cor')
        .eq('company_id', company_id)
        .ilike('nome', nome)
        .maybeSingle()
      tagId = afterRace?.id
    } else if (createError) {
      console.warn('[atendimentoSemResposta] ensureTagForConversa tag:', createError.message)
    }
  } else if (String(tag?.cor || '').toLowerCase() !== TAG_REABERTA_FALTA_RESPOSTA_COR) {
    await supabase
      .from('tags')
      .update({ cor: TAG_REABERTA_FALTA_RESPOSTA_COR })
      .eq('company_id', company_id)
      .eq('id', tagId)
      .catch(() => {})
  }
  if (!tagId) return null
  const { data: existente, error: existenteError } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('tag_id', tagId)
    .maybeSingle()
  if (existenteError) {
    console.warn('[atendimentoSemResposta] ensureTagForConversa existente:', existenteError.message)
  }
  if (!existente) {
    const { error: relError } = await supabase
      .from('conversa_tags')
      .insert({ company_id, conversa_id, tag_id: tagId })
    if (relError && !duplicateKeyError(relError)) {
      console.warn('[atendimentoSemResposta] ensureTagForConversa rel:', relError.message)
    }
  }
  return tagId
}

async function resolveGestorWhatsappDestination(company_id, cfg) {
  const clienteId = Number(cfg?.gestor_cliente_id)
  if (Number.isInteger(clienteId) && clienteId > 0) {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, pushname')
      .eq('company_id', company_id)
      .eq('id', clienteId)
      .maybeSingle()

    if (error) {
      return { ok: false, reason: 'contact_lookup_failed', error: error.message, cliente_id: clienteId }
    }
    if (!data) {
      return { ok: false, reason: 'contact_not_found', cliente_id: clienteId }
    }

    const telefone = String(data.telefone || data.wa_id || '').trim()
    if (
      telefone.includes('@g.us') ||
      telefone.toLowerCase().startsWith('lid:') ||
      (telefone.replace(/\D/g, '').startsWith('120') && telefone.replace(/\D/g, '').length >= 15)
    ) {
      return { ok: false, reason: 'group_not_supported', cliente_id: clienteId, cliente_nome: String(data.nome || data.pushname || '').trim() }
    }
    const digits = telefone.replace(/\D/g, '')
    if (!digits || digits.length < 10) {
      return {
        ok: false,
        reason: 'invalid_contact_phone',
        cliente_id: clienteId,
        cliente_nome: String(data.nome || data.pushname || '').trim(),
      }
    }

    return {
      ok: true,
      source: 'cliente',
      telefone,
      digits,
      cliente_id: clienteId,
      cliente_nome: String(data.nome || data.pushname || cfg?.gestor_cliente_nome || '').trim(),
    }
  }

  const telefone = String(cfg?.telefone_gestor || '').trim()
  const digits = telefone.replace(/\D/g, '')
  if (!digits || digits.length < 10) {
    return { ok: false, reason: 'invalid_phone', source: 'manual' }
  }
  return { ok: true, source: 'manual', telefone, digits, cliente_id: null, cliente_nome: '' }
}

async function fetchAtendenteNome(company_id, atendente_id) {
  const id = Number(atendente_id)
  if (!Number.isFinite(id) || id <= 0) return null
  const { data, error } = await supabase
    .from('usuarios')
    .select('nome, email')
    .eq('company_id', company_id)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.warn('[atendimentoSemResposta] fetchAtendenteNome:', error.message)
    return null
  }
  return String(data?.nome || data?.email || '').trim() || null
}

function formatTempoSemResposta(minutos) {
  const total = Math.max(0, Math.floor(Number(minutos) || 0))
  if (total < 60) return `${total}min`

  const days = Math.floor(total / 1440)
  const rem = total % 1440
  const hours = Math.floor(rem / 60)
  const mins = rem % 60

  if (days > 0) {
    let out = `${days}d`
    if (hours > 0) out += ` ${hours}h`
    return `${out}${mins}min`
  }

  if (mins > 0) return `${hours}h${mins}min`
  return `${hours}h`
}

function buildGestorWhatsappText({ clienteNome, atendenteNome, minutos, cfg }) {
  const tempo = formatTempoSemResposta(minutos)
  const lines = [
    '🚨 ZapERP — Atendimento sem resposta',
    '',
    `Cliente: ${clienteNome}`,
    `Atendente: ${atendenteNome || 'Não informado'}`,
    `Tempo sem resposta: ${tempo}`,
    '',
  ]
  if (cfg?.reabrir_conversa_automaticamente) {
    lines.push('Status: conversa reaberta e liberada para novo atendimento.')
  } else {
    lines.push('Status: gestor notificado; conversa permanece com o atendente atual.')
  }
  return lines.join('\n')
}

async function sendGestorWhatsapp(company_id, telefone, texto) {
  const tel = String(telefone || '').trim()
  const digits = tel.replace(/\D/g, '')
  if (!digits || digits.length < 10) return { ok: false, error: 'telefone_invalido' }
  try {
    const { getProvider } = require('./providers')
    const provider = getProvider()
    const send = provider?.sendText
    if (typeof send !== 'function') return { ok: false, error: 'sendText_indisponivel' }
    const result = await send(tel, texto, {
      companyId: company_id,
      sendOrigin: 'alerta_sem_resposta_gestor',
    })
    if (result?.ok === false || result?.error) return { ok: false, error: result.error || 'falha_envio' }
    return { ok: true, messageId: result?.messageId ?? null }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function reabrirConversa(company_id, conversa_id) {
  const reabertaEm = new Date().toISOString()
  const baseUpdate = {
    status_atendimento: 'aberta',
    atendente_id: null,
    atendente_atribuido_em: null,
  }

  let { data, error } = await supabase
    .from('conversas')
    .update({ ...baseUpdate, reaberta_falta_interacao_em: reabertaEm })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
    .select('id')
    .maybeSingle()

  if (error && String(error.message || '').includes('reaberta_falta_interacao_em')) {
    ;({ data, error } = await supabase
      .from('conversas')
      .update(baseUpdate)
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
      .select('id')
      .maybeSingle())
  }

  if (error) return { ok: false, error: error.message }

  if (!data?.id) {
    ;({ data, error } = await supabase
      .from('conversas')
      .update({ ...baseUpdate, reaberta_falta_interacao_em: reabertaEm })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .eq('status_atendimento', 'aberta')
      .is('atendente_id', null)
      .select('id')
      .maybeSingle())

    if (error && String(error.message || '').includes('reaberta_falta_interacao_em')) {
      ;({ data, error } = await supabase
        .from('conversas')
        .update(baseUpdate)
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .eq('status_atendimento', 'aberta')
        .is('atendente_id', null)
        .select('id')
        .maybeSingle())
    }
    if (error) return { ok: false, error: error.message }
    if (!data?.id) return { ok: false, error: 'conversa_nao_atualizada' }
  }

  await markReabertaFaltaInteracao(company_id, conversa_id, reabertaEm, reabertaEm)
  await supabase.from('historico_atendimentos').insert({
    conversa_id,
    usuario_id: null,
    acao: 'alerta_sem_resposta_reabertura',
    observacao: 'Conversa reaberta automaticamente por falta de resposta do atendente',
  }).catch(() => {})
  return { ok: true, reaberta_em: reabertaEm }
}

function minutesSince(iso, now = new Date()) {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((new Date(now).getTime() - ms) / 60000))
}

function parseTimeToMinutes(value, fallback) {
  const raw = String(value || '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return fallback
  }
  return h * 60 + min
}

function normalizeBusinessWindows(ct = {}) {
  const rawJanelas = Array.isArray(ct.horariosJanelas) ? ct.horariosJanelas : []
  const source = rawJanelas.length > 0
    ? rawJanelas.map((j) => ({ inicio: j?.inicio, fim: j?.fim }))
    : [{ inicio: ct.horarioInicio || '09:00', fim: ct.horarioFim || '18:00' }]

  const windows = []
  for (const item of source) {
    const start = parseTimeToMinutes(item?.inicio, null)
    const end = parseTimeToMinutes(item?.fim, null)
    if (start == null || end == null || start === end) continue
    if (start < end) {
      windows.push({ start, end })
    } else {
      windows.push({ start, end: 1440 })
      windows.push({ start: 0, end })
    }
  }

  if (!windows.length) return [{ start: 9 * 60, end: 18 * 60 }]
  return windows
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce((acc, win) => {
      const prev = acc[acc.length - 1]
      if (prev && win.start <= prev.end) {
        prev.end = Math.max(prev.end, win.end)
      } else {
        acc.push({ ...win })
      }
      return acc
    }, [])
}

function getZonedDateParts(date, timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(date))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekday = weekdayNames.indexOf(get('weekday'))
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dayKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
    dayNumber: Math.floor(Date.UTC(year, month - 1, day) / 86400000),
  }
}

function partsFromDayNumber(dayNumber) {
  const d = new Date(dayNumber * 86400000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year,
    month,
    day,
    weekday: d.getUTCDay(),
    dayKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

function normalizeBusinessSchedule(cfg = {}, fullConfig = {}) {
  const ct = fullConfig.chatbot_triage && typeof fullConfig.chatbot_triage === 'object'
    ? fullConfig.chatbot_triage
    : {}
  const merged = mergeScheduleSource(cfg, ct)
  const timezone = String(cfg.timezone || ct.timezone || 'America/Sao_Paulo').trim() || 'America/Sao_Paulo'
  return {
    enabled: cfg.horario_comercial_ativo !== false,
    timezone,
    diasSemanaDesativados: merged.diasSemanaDesativados,
    datasEspecificasFechadas: merged.datasEspecificasFechadas,
    windows: normalizeBusinessWindows(merged),
  }
}

function formatScheduleTime(minutes) {
  const n = Math.max(0, Math.min(1439, Math.floor(Number(minutes) || 0)))
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

function summarizeBusinessDays(schedule = {}) {
  if (!schedule?.enabled) return 'todos os dias'
  const closed = new Set(Array.isArray(schedule.diasSemanaDesativados) ? schedule.diasSemanaDesativados : [])
  const activeDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !closed.has(d))
  const names = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
  if (activeDays.join(',') === '1,2,3,4,5') return 'segunda a sexta'
  if (activeDays.join(',') === '1,2,3,4,5,6') return 'segunda a sabado'
  if (activeDays.join(',') === '0,1,2,3,4,5,6') return 'todos os dias'
  if (!activeDays.length) return 'nenhum dia ativo'
  return activeDays.map((d) => names[d]).join(', ')
}

function describeBusinessSchedule(schedule = {}) {
  if (!schedule?.enabled) {
    return 'Contagem ativa: horario comercial desativado. Os minutos contam de forma corrida.'
  }
  const windows = Array.isArray(schedule.windows) && schedule.windows.length
    ? schedule.windows
    : [{ start: 9 * 60, end: 18 * 60 }]
  const windowsText = windows
    .map((w) => `${formatScheduleTime(w.start)} as ${formatScheduleTime(w.end)}`)
    .join(' e ')
  const daysText = summarizeBusinessDays(schedule)
  const holidayText = Array.isArray(schedule.datasEspecificasFechadas) && schedule.datasEspecificasFechadas.length
    ? ` Datas fechadas: ${schedule.datasEspecificasFechadas.join(', ')}.`
    : ''
  return `Contagem ativa: ${daysText}, das ${windowsText}. Fora desse horario, os minutos ficam pausados e continuam no proximo expediente.${holidayText}`
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

function isBusinessDayParts(parts, schedule) {
  if (!schedule?.enabled) return true
  if (schedule.diasSemanaDesativados?.includes(parts.weekday)) return false
  if (schedule.datasEspecificasFechadas?.includes(parts.dayKey)) return false
  return true
}

function isBusinessTime(date = new Date(), schedule) {
  if (!schedule?.enabled) return true
  const parts = getZonedDateParts(date, schedule.timezone)
  if (!isBusinessDayParts(parts, schedule)) return false
  return (schedule.windows || []).some((w) => parts.minuteOfDay >= w.start && parts.minuteOfDay < w.end)
}

function businessMinutesBetween(startIso, endDate = new Date(), schedule, capMinutes = null) {
  if (!schedule?.enabled) return minutesSince(startIso, endDate)

  const start = new Date(startIso)
  const end = new Date(endDate)
  const startMs = start.getTime()
  const endMs = end.getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0

  const startParts = getZonedDateParts(start, schedule.timezone)
  const endParts = getZonedDateParts(end, schedule.timezone)
  const cap = Number.isFinite(Number(capMinutes)) && Number(capMinutes) > 0 ? Number(capMinutes) : null
  let total = 0

  for (let dayNumber = startParts.dayNumber; dayNumber <= endParts.dayNumber; dayNumber += 1) {
    const dayParts = partsFromDayNumber(dayNumber)
    if (!isBusinessDayParts(dayParts, schedule)) continue

    const rangeStart = dayNumber === startParts.dayNumber ? startParts.minuteOfDay : 0
    const rangeEnd = dayNumber === endParts.dayNumber ? endParts.minuteOfDay : 1440
    if (rangeEnd <= rangeStart) continue

    for (const win of schedule.windows || []) {
      const overlapStart = Math.max(rangeStart, win.start)
      const overlapEnd = Math.min(rangeEnd, win.end)
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart
      if (cap != null && total >= cap) return Math.floor(total)
    }
  }

  return Math.floor(total)
}

function resolveAlertaSemRespostaCycleAnchor({ ultima, estado = {}, conv = {} } = {}) {
  const ultimaEm = ultima?.criado_em ? String(ultima.criado_em) : null
  if (!ultimaEm) return null

  const ultimoClienteMs = new Date(ultimaEm).getTime()
  const estadoAnchor = estado?.ultimo_cliente_msg_em ? String(estado.ultimo_cliente_msg_em) : null
  const estadoAnchorMs = estadoAnchor ? new Date(estadoAnchor).getTime() : NaN
  const assumidaMs = conv?.atendente_atribuido_em ? new Date(conv.atendente_atribuido_em).getTime() : NaN

  if (
    estadoAnchor &&
    Number.isFinite(estadoAnchorMs) &&
    Number.isFinite(ultimoClienteMs) &&
    Number.isFinite(assumidaMs) &&
    estadoAnchorMs > ultimoClienteMs &&
    Math.abs(estadoAnchorMs - assumidaMs) <= 60 * 1000
  ) {
    return estadoAnchor
  }

  return ultimaEm
}

async function loadBusinessSchedule(company_id, cfg) {
  const effectiveCfg = resolveAlertaRuntimeConfig(cfg)
  if (!effectiveCfg.horario_comercial_ativo) return normalizeBusinessSchedule(effectiveCfg, {})
  const full = await loadIaConfig(company_id)
  return normalizeBusinessSchedule(effectiveCfg, full)
}

async function processCompanyAtendimentoSemResposta(company_id, opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const now = opts.now ? new Date(opts.now) : new Date()
  const cfg = resolveAlertaRuntimeConfig(await getAlertaSemRespostaConfig(company_id))
  const businessInfo = await getBusinessScheduleInfo(company_id, cfg)
  if (!cfg.alerta_sem_resposta_ativo) {
    return { ok: true, processadas: 0, skipped: 'inativo', horario_comercial: businessInfo }
  }
  const businessSchedule = await loadBusinessSchedule(company_id, cfg)
  if (!isBusinessTime(now, businessSchedule)) {
    return {
      ok: true,
      processadas: 0,
      skipped: 'fora_horario',
      horario_comercial: businessInfo,
      detalhes: [{
        paused: true,
        motivo: 'fora_horario',
        mensagem: 'Contador pausado fora do horario comercial.',
      }],
    }
  }

  const { data: conversas, error: convErr } = await supabase
    .from('conversas')
    .select('id, atendente_id, atendente_atribuido_em, nome_contato_cache, telefone, cliente_id')
    .eq('company_id', company_id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)

  if (convErr) return { ok: false, error: convErr.message, processadas: 0 }
  if (!conversas?.length) return { ok: true, processadas: 0, horario_comercial: businessInfo }

  let processadas = 0
  const detalhes = []

  for (const conv of conversas) {
    let ultima = null
    try {
      ultima = await fetchUltimaMensagem(company_id, conv.id)
    } catch (e) {
      detalhes.push({ conversa_id: conv.id, error: e?.message || String(e) })
      continue
    }
    if (!ultima) continue

    if (ultima.direcao !== 'in') {
      if (!dryRun) await clearEstado(company_id, conv.id)
      continue
    }

    let estado = (await getEstado(company_id, conv.id)) || {}
    let anchor = resolveAlertaSemRespostaCycleAnchor({ ultima, estado, conv })
    if (!anchor) continue

    const ultimoClienteMs = new Date(ultima.criado_em).getTime()
    const estadoAnchorMs = estado.ultimo_cliente_msg_em ? new Date(estado.ultimo_cliente_msg_em).getTime() : NaN
    const novaMensagemClienteNoCiclo =
      estado.ultimo_cliente_msg_em &&
      Number.isFinite(ultimoClienteMs) &&
      Number.isFinite(estadoAnchorMs) &&
      ultimoClienteMs > estadoAnchorMs

    if (novaMensagemClienteNoCiclo) {
      anchor = ultima.criado_em
      estado = {
        ...estado,
        ultimo_cliente_msg_em: anchor,
        primeiro_alerta_em: null,
        alerta_critico_em: null,
        gestor_notificado_em: null,
      }
      if (!dryRun) {
        await upsertEstado(company_id, conv.id, {
          ultimo_cliente_msg_em: anchor,
          primeiro_alerta_em: null,
          alerta_critico_em: null,
          gestor_notificado_em: null,
        })
      }
    } else if (!estado.ultimo_cliente_msg_em && !dryRun) {
      await upsertEstado(company_id, conv.id, { ultimo_cliente_msg_em: anchor })
    }

    const maxStageMinutes = Math.max(
      cfg.tempo_primeiro_alerta_minutos,
      cfg.tempo_alerta_critico_minutos,
      cfg.tempo_notificar_gestor_minutos
    )
    const minutos = businessMinutesBetween(anchor, now, businessSchedule, maxStageMinutes)

    const nome = conv.nome_contato_cache || conv.telefone || `Conversa ${conv.id}`
    const eventoDetalhes = { cliente_nome: nome }
    const basePayload = {
      conversa_id: conv.id,
      atendente_id: conv.atendente_id,
      detalhes: eventoDetalhes,
    }

    const actions = []

    if (minutos >= cfg.tempo_primeiro_alerta_minutos && !estado.primeiro_alerta_em) {
      actions.push({
        tipo: 'primeiro_alerta',
        nivel: 'atencao',
        mensagem: `Cliente aguardando resposta há ${minutos} min (${nome}).`,
        estadoPatch: { primeiro_alerta_em: now.toISOString() },
      })
    }

    if (minutos >= cfg.tempo_alerta_critico_minutos && !estado.alerta_critico_em) {
      actions.push({
        tipo: 'alerta_critico',
        nivel: 'critico',
        mensagem: `Alerta crítico: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { alerta_critico_em: now.toISOString() },
      })
    }

    if (minutos >= cfg.tempo_notificar_gestor_minutos && !estado.gestor_notificado_em) {
      actions.push({
        tipo: 'gestor_notificado',
        nivel: 'gestor',
        mensagem: `Gestor notificado: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { gestor_notificado_em: now.toISOString() },
        notifyGestor: true,
      })
    }

    if (!actions.length) continue

    if (dryRun) {
      processadas += 1
      detalhes.push({ conversa_id: conv.id, minutos, acoes: actions.map((a) => a.tipo) })
      continue
    }

    const executedActions = []
    for (const action of actions) {
      let stillEligible = false
      try {
        stillEligible = await revalidateConversaElegivel(company_id, conv, anchor)
      } catch (e) {
        console.warn('[atendimentoSemResposta] revalidate:', e?.message || e)
      }
      if (!stillEligible) continue

      const isGestorNotify = action.notifyGestor === true
      let claimed = false
      if (!isGestorNotify) {
        claimed = await claimEstadoStage(company_id, conv.id, anchor, action.estadoPatch)
        if (!claimed) continue
      }

      let gestorWhatsappOk = !(isGestorNotify && cfg.notificar_por_whatsapp)

      if (cfg.notificar_interno !== false) {
        emitAlertaRealtime(io, company_id, { ...basePayload, ...action }, {
          gestorId: action.notifyGestor ? cfg.gestor_notificado_id : null,
        })
        await recordEvento(company_id, { ...basePayload, ...action })
      }

      if (action.notifyGestor) {
        if (cfg.notificar_por_whatsapp) {
          const destination = await resolveGestorWhatsappDestination(company_id, cfg)
          if (!destination.ok) {
            gestorWhatsappOk = false
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'whatsapp_falha',
              nivel: 'gestor',
              mensagem: destination.error || destination.reason || 'Contato do gestor inválido',
              detalhes: {
                reason: destination.reason,
                cliente_id: destination.cliente_id ?? cfg.gestor_cliente_id ?? null,
              },
            })
          } else {
            const atendenteNome = await fetchAtendenteNome(company_id, conv.atendente_id)
            const waText = buildGestorWhatsappText({
              clienteNome: nome,
              atendenteNome,
              minutos,
              cfg,
            })
            const wa = await sendGestorWhatsapp(company_id, destination.telefone, waText)
            if (!wa.ok) {
              gestorWhatsappOk = false
              await recordEvento(company_id, {
                ...basePayload,
                tipo: 'whatsapp_falha',
                nivel: 'gestor',
                mensagem: wa.error || 'Falha ao enviar WhatsApp ao gestor',
                detalhes: {
                  destino: destination.source,
                  cliente_id: destination.cliente_id,
                  cliente_nome: destination.cliente_nome || cfg.gestor_cliente_nome || null,
                },
              })
            } else {
              gestorWhatsappOk = true
              await recordEvento(company_id, {
                ...basePayload,
                tipo: 'whatsapp_enviado',
                nivel: 'gestor',
                mensagem: `WhatsApp enviado para ${destination.cliente_nome || destination.telefone}.`,
                detalhes: {
                  destino: destination.source,
                  cliente_id: destination.cliente_id,
                  cliente_nome: destination.cliente_nome || cfg.gestor_cliente_nome || null,
                },
              })
            }
          }
        }

        if (isGestorNotify && cfg.notificar_por_whatsapp && !gestorWhatsappOk) {
          continue
        }

        if (isGestorNotify) {
          claimed = await claimEstadoStage(company_id, conv.id, anchor, action.estadoPatch)
          if (!claimed) continue
        }

        if (cfg.notificar_por_email) {
          const emailDestination = await resolveGestorEmailDestination(company_id, cfg)
          const smtpConfigured = hasSmtpConfig()
          await recordEvento(company_id, {
            ...basePayload,
            tipo: 'email_indisponivel',
            nivel: 'gestor',
            mensagem: !emailDestination.ok
              ? 'E-mail do gestor não enviado: responsável interno sem e-mail válido.'
              : !smtpConfigured
                ? 'E-mail do gestor não enviado: SMTP não configurado.'
                : 'E-mail do gestor não enviado: serviço de envio não implementado no backend.',
            detalhes: {
              reason: emailDestination.ok
                ? (smtpConfigured ? 'email_sender_not_configured' : 'smtp_not_configured')
                : emailDestination.reason,
              gestor_id: emailDestination.gestor_id ?? cfg.gestor_notificado_id ?? null,
              smtp_configurado: smtpConfigured,
            },
          })
        }

        if (cfg.reabrir_conversa_automaticamente) {
          const reopened = await reabrirConversa(company_id, conv.id)
          if (reopened.ok) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'conversa_reaberta',
              nivel: 'gestor',
              mensagem: `Conversa ${conv.id} reaberta automaticamente após notificação ao gestor.`,
            })
            if (io) {
              const reabertaEm = reopened.reaberta_em || new Date().toISOString()
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: conv.id,
                status_atendimento: 'aberta',
                atendente_id: null,
                exibir_badge_aberta: true,
                reaberta_por_falta_interacao: true,
                reaberta_falta_interacao_em: reabertaEm,
              })
            }
          }
        } else if (io) {
          io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
            id: conv.id,
            reaberta_por_falta_interacao: false,
          })
        }

        if (cfg.aplicar_tag_automatica) {
          const tagId = await ensureTagForConversa(company_id, conv.id, cfg.nome_tag_automatica)
          if (tagId) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'tag_aplicada',
              nivel: 'gestor',
              mensagem: `Tag "${cfg.nome_tag_automatica}" aplicada.`,
              metadata: { tag_id: tagId },
            })
            if (io) {
              const tags = await fetchConversaTagsForRealtime(company_id, conv.id)
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: conv.id,
                tags,
              })
            }
          }
        }
      }

      await upsertEstado(company_id, conv.id, {
        ultimo_cliente_msg_em: anchor,
        ...action.estadoPatch,
      })
      executedActions.push(action.tipo)
    }

    if (executedActions.length) {
      processadas += 1
      detalhes.push({ conversa_id: conv.id, minutos, acoes: executedActions })
    }
  }

  return { ok: true, processadas, detalhes, horario_comercial: businessInfo }
}

async function runAtendimentoSemRespostaForAllCompanies(opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const { data: empresas, error } = await supabase.from('empresas').select('id')
  if (error) return { ok: false, error: error.message, processadas: 0 }

  let total = 0
  const detalhes = []
  for (const emp of empresas || []) {
    const r = await processCompanyAtendimentoSemResposta(emp.id, { dryRun, io, now: opts.now })
    if (!r.ok) {
      detalhes.push({ company_id: emp.id, error: r.error })
      continue
    }
    total += r.processadas || 0
    if (r.detalhes?.length) detalhes.push({ company_id: emp.id, itens: r.detalhes })
  }
  return { ok: true, processadas: total, detalhes }
}

module.exports = {
  DEFAULT_ALERTA_SEM_RESPOSTA,
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  getAlertaSemRespostaConfig,
  getAlertaSemRespostaConfigForApi,
  resolveAlertaRuntimeConfig,
  mergeScheduleSource,
  alertConfigHasOwnSchedule,
  saveAlertaSemRespostaConfig,
  listAlertaSemRespostaEventos,
  processCompanyAtendimentoSemResposta,
  runAtendimentoSemRespostaForAllCompanies,
  emitAlertaRealtime,
  clearEstado,
  clearReabertaFaltaInteracao,
  resetAlertaSemRespostaAoAssumirReaberta,
  buildAlertaSemRespostaResetPatch,
  normalizeBusinessSchedule,
  isBusinessTime,
  businessMinutesBetween,
  describeBusinessSchedule,
  getBusinessScheduleInfo,
  resolveAlertaSemRespostaCycleAnchor,
  resolveGestorWhatsappDestination,
  sendGestorWhatsapp,
  formatTempoSemResposta,
  buildGestorWhatsappText,
}
