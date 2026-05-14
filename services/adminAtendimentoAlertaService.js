/**
 * Alerta automático ao administrador — resumo de atendimento (WhatsApp).
 * Deploy: a migration em 202605141305 força admin_atendimento_alerta.ativo = false em todas as
 * linhas existentes de ia_config; ativação somente manual no painel (empresa de teste, etc.).
 * Contagem "aguardando resposta" alinhada ao selo Aguardando funcionário na lista de chats:
 * em_atendimento, com atendente, sem aguardando_cliente_desde, última mensagem in, não grupo.
 */

const supabase = require('../config/supabase')

const DEFAULT_ADMIN_ATENDIMENTO_ALERTA = {
  ativo: false,
  telefone_admin: '',
  horario_envio: '09:00',
  incluir_nota_media: false,
  incluir_conversas_sem_resposta: false,
}

const MSG_PAGE = 800
const CONV_CHUNK = 120
const NOTA_MEDIA_DIAS = 30
const JANELA_MINUTOS = 5

function normalizeDigitsPhone(raw) {
  return String(raw ?? '').replace(/\D/g, '')
}

function maskPhoneTail(digits) {
  const d = normalizeDigitsPhone(digits)
  if (d.length < 4) return '****'
  return `****${d.slice(-4)}`
}

function formatHm(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function localYmdAndHm(date, timezone) {
  const tz = timezone && String(timezone).trim() ? String(timezone).trim() : 'America/Sao_Paulo'
  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const hmFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const ymd = ymdFmt.format(date)
  const parts = Object.fromEntries(hmFmt.formatToParts(date).map((x) => [x.type, x.value]))
  return { dia_local: ymd, hm: formatHm(parts.hour, parts.minute), timezone: tz }
}

function parseHm(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return { h: 9, min: 0 }
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)))
  const mi = Math.max(0, Math.min(59, parseInt(m[2], 10)))
  return { h, min: mi }
}

function minutesOfDay(hmStr) {
  const { h, min } = parseHm(hmStr)
  return h * 60 + min
}

function withinScheduleWindow(nowHm, slotHm, windowMin = JANELA_MINUTOS) {
  const a = minutesOfDay(nowHm)
  const b = minutesOfDay(slotHm)
  const d = Math.abs(a - b)
  const wrap = 24 * 60 - d
  return Math.min(d, wrap) <= windowMin
}

function normalizeAdminAtendimentoAlerta(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const tel = normalizeDigitsPhone(src.telefone_admin)
  const hm = String(src.horario_envio || '09:00').trim()
  const horario_envio = /^\d{1,2}:\d{2}$/.test(hm) ? formatHm(parseHm(hm).h, parseHm(hm).min) : '09:00'
  return {
    ativo: !!src.ativo,
    telefone_admin: tel.slice(0, 20),
    horario_envio,
    incluir_nota_media: !!src.incluir_nota_media,
    incluir_conversas_sem_resposta: !!src.incluir_conversas_sem_resposta,
  }
}

function isGrupoRow(row) {
  const tipo = String(row?.tipo || '').toLowerCase()
  const tel = String(row?.telefone || '')
  if (tipo === 'grupo') return true
  if (tel.includes('@g.us')) return true
  if (tel.toLowerCase().startsWith('lid:')) return true
  return false
}

async function fetchLastMessageMap(companyId, conversaIds) {
  const ids = [...new Set((conversaIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!ids.length) return new Map()

  async function fetchSlice(convIds) {
    const needed = new Set(convIds)
    const map = new Map()
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('mensagens')
        .select('conversa_id, direcao, criado_em')
        .eq('company_id', companyId)
        .in('conversa_id', convIds)
        .in('direcao', ['in', 'out'])
        .not('criado_em', 'is', null)
        .order('criado_em', { ascending: false, nullsFirst: false })
        .range(offset, offset + MSG_PAGE - 1)
      if (error) throw error
      const rows = data || []
      for (const msg of rows) {
        const cid = Number(msg.conversa_id)
        if (!needed.has(cid)) continue
        if (!map.has(cid)) map.set(cid, msg)
      }
      if (rows.length < MSG_PAGE) break
      offset += MSG_PAGE
      if (map.size >= needed.size) break
    }
    return map
  }

  if (ids.length <= CONV_CHUNK) return fetchSlice(ids)
  const merged = new Map()
  for (let i = 0; i < ids.length; i += CONV_CHUNK) {
    const slice = ids.slice(i, i + CONV_CHUNK)
    const part = await fetchSlice(slice)
    for (const [k, v] of part) {
      if (!merged.has(k)) merged.set(k, v)
    }
  }
  return merged
}

/**
 * Conta conversas no mesmo critério do selo "Aguardando funcionário" (lista de chats).
 */
async function countConversasAguardandoFuncionario(company_id) {
  const { data: rows, error } = await supabase
    .from('conversas')
    .select('id, tipo, telefone')
    .eq('company_id', company_id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)
    .is('aguardando_cliente_desde', null)

  if (error) {
    console.warn('[adminAtendimentoAlerta] count conversas:', error.message)
    return null
  }
  const candidatas = (rows || []).filter((r) => !isGrupoRow(r))
  if (!candidatas.length) return 0

  const lastMap = await fetchLastMessageMap(
    company_id,
    candidatas.map((r) => r.id)
  )

  let n = 0
  for (const c of candidatas) {
    const last = lastMap.get(Number(c.id))
    if (!last || last.direcao !== 'in') continue
    n++
  }
  return n
}

async function mediaNotaAtendimentos(company_id, dias = NOTA_MEDIA_DIAS) {
  const d = Math.max(1, Math.min(365, Number(dias) || NOTA_MEDIA_DIAS))
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  try {
    const { data, error } = await supabase
      .from('avaliacoes_atendimento')
      .select('nota')
      .eq('company_id', company_id)
      .gte('criado_em', desde)
    if (error) return null
    if (!data?.length) return null
    let soma = 0
    let k = 0
    for (const r of data) {
      const v = Number(r.nota)
      if (Number.isFinite(v) && v >= 0 && v <= 10) {
        soma += v
        k++
      }
    }
    if (!k) return null
    return Math.round((soma / k) * 10) / 10
  } catch (e) {
    if (String(e?.code || '') === '42P01') return null
    console.warn('[adminAtendimentoAlerta] media nota:', e?.message || e)
    return null
  }
}

function buildMessage({ incluir_nota_media, incluir_conversas_sem_resposta, mediaNota, qtdSemResposta }) {
  const lines = ['📊 Resumo do atendimento:']
  if (incluir_nota_media && mediaNota != null) {
    lines.push(`Nota média dos atendimentos: ${String(mediaNota).replace('.', ',')}`)
  }
  if (incluir_conversas_sem_resposta && qtdSemResposta != null) {
    lines.push(`Conversas aguardando resposta: ${qtdSemResposta}`)
  }
  if (lines.length === 1) return null
  return lines.join('\n')
}

/**
 * Tenta reservar slot de envio (idempotência). Retorna { reserved: true, id } ou { reserved: false }.
 */
async function tryReserveEnvioSlot(company_id, dia_local, horario_slot) {
  const { data, error } = await supabase
    .from('admin_atendimento_alerta_envios')
    .insert({
      company_id,
      dia_local,
      horario_slot,
      ok: false,
      erro: null,
      telefone_mascarado: null,
      metricas: null,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    const code = String(error.code || '')
    const msg = String(error.message || '').toLowerCase()
    if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
      return { reserved: false, reason: 'duplicate_slot' }
    }
    console.warn('[adminAtendimentoAlerta] reserve slot erro:', error.message)
    return { reserved: false, reason: 'db_error' }
  }
  if (!data?.id) return { reserved: false, reason: 'no_row' }
  return { reserved: true, id: data.id }
}

async function finalizeEnvioRow(id, { ok, erro, telefone_mascarado, metricas }) {
  await supabase
    .from('admin_atendimento_alerta_envios')
    .update({
      ok: !!ok,
      erro: erro != null ? String(erro).slice(0, 2000) : null,
      telefone_mascarado: telefone_mascarado != null ? String(telefone_mascarado).slice(0, 32) : null,
      metricas: metricas && typeof metricas === 'object' ? metricas : null,
    })
    .eq('id', id)
}

/**
 * Processa uma empresa (chamado pelo job de cron).
 */
async function processCompanyAdminAlert({ company_id, fullConfig, provider }) {
  const cfgRoot = fullConfig && typeof fullConfig === 'object' ? fullConfig : {}
  const tzSource = cfgRoot.chatbot_triage?.timezone || 'America/Sao_Paulo'
  const alertRaw = cfgRoot.admin_atendimento_alerta
  const alert = normalizeAdminAtendimentoAlerta(alertRaw || {})

  if (!alert.ativo) return { skipped: true, reason: 'inactive' }

  const digits = normalizeDigitsPhone(alert.telefone_admin)
  if (digits.length < 10) {
    console.warn('[adminAtendimentoAlerta] company', company_id, 'telefone_admin inválido — ignorando')
    return { skipped: true, reason: 'invalid_phone' }
  }

  const { dia_local, hm: nowHm, timezone } = localYmdAndHm(new Date(), tzSource)
  if (!withinScheduleWindow(nowHm, alert.horario_envio)) {
    return { skipped: true, reason: 'outside_window' }
  }

  const reserve = await tryReserveEnvioSlot(company_id, dia_local, alert.horario_envio)
  if (!reserve.reserved) {
    return { skipped: true, reason: reserve.reason || 'not_reserved' }
  }
  const rowId = reserve.id

  let mediaNota = null
  let qtdSemResposta = null
  if (alert.incluir_nota_media) {
    mediaNota = await mediaNotaAtendimentos(company_id, NOTA_MEDIA_DIAS)
  }
  if (alert.incluir_conversas_sem_resposta) {
    qtdSemResposta = await countConversasAguardandoFuncionario(company_id)
    if (qtdSemResposta == null) qtdSemResposta = 0
  }

  const texto = buildMessage({
    incluir_nota_media: alert.incluir_nota_media,
    incluir_conversas_sem_resposta: alert.incluir_conversas_sem_resposta,
    mediaNota,
    qtdSemResposta,
  })

  const metricas = {
    timezone,
    dia_local,
    incluir_nota_media: alert.incluir_nota_media,
    incluir_conversas_sem_resposta: alert.incluir_conversas_sem_resposta,
    media_nota_30d: mediaNota,
    conversas_sem_resposta: qtdSemResposta,
  }

  if (!texto) {
    await finalizeEnvioRow(rowId, {
      ok: true,
      erro: null,
      telefone_mascarado: maskPhoneTail(digits),
      metricas: { ...metricas, note: 'sem_metricas_ativas_ou_sem_dados' },
    })
    console.log('[adminAtendimentoAlerta] company', company_id, 'sem linhas de métrica — slot registrado sem envio WhatsApp')
    return { ok: true, sent: false, reason: 'empty_message' }
  }

  if (!provider?.sendText) {
    await finalizeEnvioRow(rowId, {
      ok: false,
      erro: 'Provider de envio indisponível',
      telefone_mascarado: maskPhoneTail(digits),
      metricas,
    })
    return { ok: false, sent: false, error: 'no_provider' }
  }

  try {
    const sendRes = await provider.sendText(digits, texto, { companyId: company_id })
    const ok = !!sendRes?.ok
    await finalizeEnvioRow(rowId, {
      ok,
      erro: ok ? null : String(sendRes?.error || 'Falha ao enviar'),
      telefone_mascarado: maskPhoneTail(digits),
      metricas,
    })
    console.log(
      `[adminAtendimentoAlerta] company=${company_id} dest=${maskPhoneTail(digits)} ok=${ok} dia=${dia_local} tz=${timezone}`
    )
    return { ok, sent: ok, messageId: sendRes?.messageId || null }
  } catch (e) {
    const msg = e?.message || String(e)
    await finalizeEnvioRow(rowId, {
      ok: false,
      erro: msg,
      telefone_mascarado: maskPhoneTail(digits),
      metricas,
    })
    console.warn('[adminAtendimentoAlerta] envio exceção company', company_id, msg)
    return { ok: false, sent: false, error: msg }
  }
}

module.exports = {
  DEFAULT_ADMIN_ATENDIMENTO_ALERTA,
  normalizeAdminAtendimentoAlerta,
  countConversasAguardandoFuncionario,
  mediaNotaAtendimentos,
  processCompanyAdminAlert,
  localYmdAndHm,
  withinScheduleWindow,
}
