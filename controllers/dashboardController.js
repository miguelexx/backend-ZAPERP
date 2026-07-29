const supabase = require('../config/supabase')
const { REAL_MESSAGE_DIRECOES } = require('../helpers/internalNote')
const { isEnabled, FLAGS } = require('../helpers/featureFlags')
const { getDisplayName } = require('../helpers/contactEnrichment')
const { normalizePositiveIds, isGroupRow } = require('../helpers/departamentoGruposHelper')
const slaCalculationService = require('../services/slaCalculationService')
const ExcelJS = require('exceljs')
const PDFDocument = require('pdfkit')

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function clampInt(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  return Math.max(min, Math.min(max, Math.trunc(x)))
}

const PAGE_SIZE = 1000

async function fetchAllRows(buildQuery) {
  const all = []
  let from = 0
  for (;;) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await buildQuery().range(from, to)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

async function getSlaMinutes(company_id) {
  const { data: emp, error } = await supabase
    .from('empresas')
    .select('sla_minutos_sem_resposta')
    .eq('id', company_id)
    .maybeSingle()
  if (error) return 5
  const raw = Number(emp?.sla_minutos_sem_resposta)
  if (!Number.isFinite(raw)) return 5
  return Math.max(1, Math.min(1440, Math.trunc(raw)))
}

/** Nomes de atendentes sem embed PostgREST (FK `conversas_atendente_fk` foi removida na dedupe). */
async function fetchUsuariosNomeMap(company_id, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const map = {}
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  if (error) throw error
  for (const u of data || []) {
    if (u?.id != null) map[String(u.id)] = u?.nome || 'Sem nome'
  }
  return map
}

/** Primeira resposta outbound após a primeira inbound (evita TypeError se não houver msg `in`). */
function findPrimeiraRespostaPair(msgs) {
  const primeiraIn = (msgs || []).find((m) => m?.direcao === 'in')
  if (!primeiraIn?.criado_em) return { primeiraIn: null, primeiraOut: null }
  const inTs = new Date(primeiraIn.criado_em).getTime()
  if (!Number.isFinite(inTs)) return { primeiraIn: null, primeiraOut: null }
  const primeiraOut = (msgs || []).find((m) => {
    if (m?.direcao !== 'out' || !m?.criado_em) return false
    const outTs = new Date(m.criado_em).getTime()
    return Number.isFinite(outTs) && outTs >= inTs
  })
  return { primeiraIn, primeiraOut: primeiraOut || null }
}

const SAO_PAULO_TZ = 'America/Sao_Paulo'

function parseDateOnly(value) {
  const s = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return { y, m, d, value: s }
}

function saoPauloDateStartIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  // Brasil nao usa DST atualmente; 00:00 em America/Sao_Paulo = 03:00 UTC.
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 3, 0, 0, 0)).toISOString()
}

function saoPauloDateEndIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + 1, 2, 59, 59, 999)).toISOString()
}

function formatSaoPauloDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = {}
  for (const part of parts) map[part.type] = part.value
  return `${map.year}-${map.month}-${map.day}`
}

function todaySaoPauloDateKey() {
  return formatSaoPauloDateKey(new Date())
}

function addDaysDateKey(dateKey, days) {
  const parsed = parseDateOnly(dateKey)
  if (!parsed) return todaySaoPauloDateKey()
  return formatSaoPauloDateKey(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + days, 12, 0, 0, 0)))
}

function getDateRangeFromQuery(query = {}) {
  const today = todaySaoPauloDateKey()
  const dataFim = parseDateOnly(query.data_fim)?.value || today
  const dataInicio = parseDateOnly(query.data_inicio)?.value || addDaysDateKey(dataFim, -6)
  return {
    data_inicio: dataInicio,
    data_fim: dataFim,
    fromIso: saoPauloDateStartIso(dataInicio),
    toIso: saoPauloDateEndIso(dataFim),
  }
}

function toPositiveInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

function avg(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v))
  if (nums.length === 0) return null
  return nums.reduce((sum, v) => sum + v, 0) / nums.length
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function percent(part, total) {
  if (!total) return null
  return Math.round((part / total) * 1000) / 10
}

function buildGroupRanking(items, keyGetter, labelGetter) {
  const map = new Map()
  for (const item of items) {
    const key = keyGetter(item)
    const label = labelGetter(item)
    if (!map.has(key)) {
      map.set(key, { id: key, nome: label, total_analisadas: 0, dentro_sla: 0, fora_sla: 0, tempos: [] })
    }
    const row = map.get(key)
    row.total_analisadas += 1
    row.tempos.push(item.tempo_resposta_min)
    if (item.cumpriu_sla) row.dentro_sla += 1
    else row.fora_sla += 1
  }
  return Array.from(map.values())
    .map((row) => ({
      id: row.id,
      nome: row.nome,
      total_analisadas: row.total_analisadas,
      dentro_sla: row.dentro_sla,
      fora_sla: row.fora_sla,
      percentual_cumprido: percent(row.dentro_sla, row.total_analisadas),
      tempo_medio_primeira_resposta_min: round1(avg(row.tempos)),
    }))
    .sort((a, b) => b.total_analisadas - a.total_analisadas || (b.percentual_cumprido || 0) - (a.percentual_cumprido || 0))
}

async function fetchDepartamentosNomeMap(company_id, depIds) {
  const ids = [...new Set((depIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const map = {}
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  if (error) throw error
  for (const d of data || []) {
    if (d?.id != null) map[String(d.id)] = d?.nome || 'Sem setor'
  }
  return map
}

function chunkArray(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function fetchMensagensForConversas(company_id, conversaIds) {
  const ids = [...new Set((conversaIds || []).filter(Boolean))]
  if (ids.length === 0) return []
  const all = []
  for (const chunk of chunkArray(ids, 200)) {
    const rows = await fetchAllRows(() =>
      supabase
        .from('mensagens')
        .select('id, conversa_id, criado_em, direcao, autor_usuario_id')
        .eq('company_id', company_id)
        .in('conversa_id', chunk)
        .in('direcao', ['in', 'out'])
        .order('criado_em', { ascending: true })
    )
    all.push(...rows)
  }
  return all
}

async function buildSlaAnalytics(company_id, query = {}, opts = {}) {
  return slaCalculationService.buildSlaAnalytics(company_id, query, opts)
}

exports.overview = async (req, res) => {
  const { company_id } = req.user

  try {
    // Filtro de período (opcional): últimos N dias
    // - Sem range_days → mantém comportamento antigo (tudo)
    // - Com range_days → evita dashboard "pesado" e deixa mais útil
    const rangeDays = clampInt(req.query?.range_days, 1, 365)
    const now = new Date()
    const fromIso = rangeDays ? new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000).toISOString() : null
    const toIso = now.toISOString()

    /* ===============================
       1. STATUS DAS CONVERSAS (KPIs)
    =============================== */
    const conversas = await fetchAllRows(() => {
      let q = supabase
        .from('conversas')
        // Não embute departamentos aqui: em alguns schemas o PostgREST detecta mais de 1 relacionamento
        // e quebra com "Could not embed because more than one relationship was found..."
        .select('status_atendimento, criado_em, atendente_id, departamento_id')
        .eq('company_id', company_id)
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    const kpis = {
      total: conversas.length,
      abertas: 0,
      em_atendimento: 0,
      fechadas: 0,
      tempo_primeira_resposta_min: null,
      atendimentos_hoje: 0,
      tempo_medio_resposta_min: null,
      sla_percent: null,
      atendente_mais_produtivo: null,
      tickets_abertos: 0,
    }

    conversas.forEach(c => {
      if (c.status_atendimento === 'aberta') kpis.abertas++
      if (c.status_atendimento === 'em_atendimento' || c.status_atendimento === 'aguardando_cliente') kpis.em_atendimento++
      if (c.status_atendimento === 'fechada') kpis.fechadas++
    })

    // Abertas: só contar as que têm movimentação (mensagem ou atendente assumiu)
    const { data: countAbertasComMov, error: errCountAbertas } = await supabase
      .rpc('count_conversas_abertas_com_movimentacao', {
        p_company_id: company_id,
        p_from_iso: fromIso || null,
        p_to_iso: toIso || null
      })
    if (!errCountAbertas && countAbertasComMov != null) {
      kpis.abertas = Number(countAbertasComMov) || 0
    }

    kpis.tickets_abertos = kpis.abertas + kpis.em_atendimento

    // Conversas por setor (departamento) — resolve nomes manualmente (sem embed)
    const setorMap = {}
    const depIds = [...new Set((conversas || []).map((c) => c?.departamento_id).filter((id) => id != null))]
    let depMap = {}
    if (depIds.length > 0) {
      const { data: deps, error: errDeps } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', depIds)
      if (!errDeps && Array.isArray(deps)) {
        deps.forEach((d) => {
          if (d?.id != null) depMap[String(d.id)] = d?.nome || null
        })
      }
    }
    for (const c of conversas || []) {
      const depId = c?.departamento_id
      const nome = depId != null ? (depMap[String(depId)] || 'Sem setor') : 'Sem setor'
      setorMap[nome] = (setorMap[nome] || 0) + 1
    }
    const conversas_por_setor = Object.entries(setorMap)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)

    /* ===============================
       ATENDIMENTOS HOJE (registros na tabela atendimentos)
    =============================== */
    const hoje = startOfToday()
    try {
      const atendimentosHoje = await fetchAllRows(() =>
        supabase
          .from('atendimentos')
          .select('id')
          .eq('company_id', company_id)
          .gte('criado_em', hoje)
      )
      kpis.atendimentos_hoje = atendimentosHoje.length
    } catch (_) {}

    /* ===============================
       2. TEMPO MÉDIO DA 1ª RESPOSTA (SLA)
    =============================== */
    const mensagens = await fetchAllRows(() => {
      let q = supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao, tipo')
        .eq('company_id', company_id)
        .in('direcao', ['in', 'out'])
        .order('criado_em', { ascending: true })
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    const mensagensPorConversa = {}
    const msgTipoMap = {}
    let msgIn = 0
    let msgOut = 0

    mensagens.forEach(msg => {
      if (!mensagensPorConversa[msg.conversa_id]) {
        mensagensPorConversa[msg.conversa_id] = []
      }
      mensagensPorConversa[msg.conversa_id].push(msg)

      const t = String(msg?.tipo || 'texto').toLowerCase()
      msgTipoMap[t] = (msgTipoMap[t] || 0) + 1
      if (msg?.direcao === 'in') msgIn++
      if (msg?.direcao === 'out') msgOut++
    })

    let totalMinutos = 0
    let totalConversasComResposta = 0

    Object.values(mensagensPorConversa).forEach((msgs) => {
      const { primeiraIn, primeiraOut } = findPrimeiraRespostaPair(msgs)
      if (primeiraIn && primeiraOut) {
        const diff =
          (new Date(primeiraOut.criado_em) - new Date(primeiraIn.criado_em)) / 60000
        if (diff >= 0) {
          totalMinutos += diff
          totalConversasComResposta++
        }
      }
    })

    if (totalConversasComResposta > 0) {
      const media = totalMinutos / totalConversasComResposta
      kpis.tempo_primeira_resposta_min = Math.round(media)
      kpis.tempo_medio_resposta_min = Math.round(media * 10) / 10
    }

    const slaMinutes = await getSlaMinutes(company_id)
    /* SLA: % de conversas com 1ª resposta dentro da configuração da empresa */
    let conversasComSla = 0
    Object.values(mensagensPorConversa).forEach((msgs) => {
      const { primeiraIn, primeiraOut } = findPrimeiraRespostaPair(msgs)
      if (primeiraIn && primeiraOut) {
        const diff = (new Date(primeiraOut.criado_em) - new Date(primeiraIn.criado_em)) / 60000
        if (diff >= 0 && diff <= slaMinutes) conversasComSla++
      }
    })
    const totalComResposta = Object.values(mensagensPorConversa).filter(msgs => {
      const primeiraIn = msgs.find(m => m.direcao === 'in')
      const primeiraOut = msgs.find(m => m.direcao === 'out')
      return primeiraIn && primeiraOut
    }).length
    if (totalComResposta > 0) {
      kpis.sla_percent = Math.round((conversasComSla / totalComResposta) * 100)
    }

    const mensagens_por_tipo = Object.entries(msgTipoMap)
      .map(([tipo, total]) => ({ tipo, total }))
      .sort((a, b) => b.total - a.total)

    const mensagens_kpis = {
      total: (mensagens || []).length,
      in: msgIn,
      out: msgOut,
    }

    /* ===============================
       3. CONVERSAS POR ATENDENTE + ATENDENTE MAIS PRODUTIVO
    =============================== */
    const porAtendente = await fetchAllRows(() => {
      let q = supabase
        .from('conversas')
        .select('atendente_id')
        .eq('company_id', company_id)
        .not('atendente_id', 'is', null)
      if (fromIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      return q
    })

    const usuarioNomeMap = await fetchUsuariosNomeMap(
      company_id,
      (porAtendente || []).map((c) => c?.atendente_id)
    )

    const atendentesMap = {}

    porAtendente.forEach((c) => {
      const nome = usuarioNomeMap[String(c?.atendente_id)] || 'Sem nome'
      atendentesMap[nome] = (atendentesMap[nome] || 0) + 1
    })

    const conversasPorAtendente = Object.entries(atendentesMap).map(
      ([nome, total]) => ({
        nome,
        total,
      })
    )

    if (conversasPorAtendente.length > 0) {
      const top = conversasPorAtendente.sort((a, b) => b.total - a.total)[0]
      kpis.atendente_mais_produtivo = top?.nome ?? null
    }

    /* ===============================
       4. CONVERSAS POR HORA
    =============================== */
    const porHoraMap = {}

    conversas.forEach(c => {
      const hora = new Date(c.criado_em).getHours()
      porHoraMap[hora] = (porHoraMap[hora] || 0) + 1
    })

    const conversasPorHora = Object.entries(porHoraMap)
      .map(([hora, total]) => ({
        hora: `${hora.toString().padStart(2, '0')}:00`,
        total,
      }))
      .sort((a, b) => a.hora.localeCompare(b.hora))

    /* ===============================
       RESPONSE FINAL
    =============================== */
    res.json({
      periodo: {
        range_days: rangeDays,
        from: fromIso,
        to: toIso,
      },
      kpis,
      mensagens_kpis,
      mensagens_por_tipo,
      conversas_por_setor,
      conversas_por_atendente: conversasPorAtendente,
      conversas_por_hora: conversasPorHora,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao gerar dashboard' })
  }
}

/**
 * GET /api/dashboard/metrics
 *
 * Endpoint profissional de métricas para IA/BI.
 * Usa SOMENTE dados reais das tabelas:
 * - empresas, usuarios, clientes, conversas, mensagens, atendimentos
 *
 * Retorno:
 * {
 *   atendimentosHoje,              // ações registradas hoje na tabela atendimentos
 *   conversasHoje,                 // conversas criadas hoje
 *   totalConversas,                // total de conversas da empresa
 *   conversasAbertas,              // status_atendimento = aberta
 *   conversasEmAtendimento,        // status_atendimento = em_atendimento
 *   conversasAguardandoCliente,    // status_atendimento = aguardando_cliente
 *   conversasFechadas,             // status_atendimento = fechada
 *   tempoMedioPrimeiraResposta,    // minutos (float)
 *   slaPercentualRespondidas,      // % dentro do SLA (apenas conversas com resposta)
 *   slaPercentualTotal,            // % dentro do SLA considerando também sem resposta
 *   atendenteMaisProdutivo,        // { id, nome, totalConversas } ou null
 *   ticketsAbertos,                // conversas abertas + em_atendimento
 *   mensagensRecebidas,            // mensagens.direcao = 'in'
 *   mensagensEnviadas              // mensagens.direcao = 'out'
 * }
 */
exports.metrics = async (req, res) => {
  const { company_id } = req.user

  try {
    const hoje = new Date()
    hoje.setHours(0, 0, 0, 0)
    const hojeIso = hoje.toISOString()

    // 1) Carregar config de SLA da empresa (minutos sem resposta)
    let slaMinutos = 30
    {
      const { data: emp, error: errEmp } = await supabase
        .from('empresas')
        .select('sla_minutos_sem_resposta')
        .eq('id', company_id)
        .single()
      if (!errEmp && emp && typeof emp.sla_minutos_sem_resposta === 'number') {
        slaMinutos = Math.max(1, Math.min(1440, emp.sla_minutos_sem_resposta))
      }
    }

    // 2) Conversas da empresa (base para várias métricas)
    const { data: conversas, error: errConversas } = await supabase
      .from('conversas')
      .select('id, criado_em, status_atendimento, atendente_id')
      .eq('company_id', company_id)

    if (errConversas) throw errConversas

    const totalConversas = conversas?.length || 0
    let conversasHoje = 0
    let ticketsAbertos = 0
    let conversasAbertas = 0
    let conversasEmAtendimento = 0
    let conversasAguardandoCliente = 0
    let conversasFechadas = 0

    const contagemPorAtendente = new Map()

    for (const c of conversas || []) {
      const criadoEm = c?.criado_em ? new Date(c.criado_em) : null
      if (criadoEm && criadoEm >= hoje) conversasHoje++

      if (c.status_atendimento === 'aberta') {
        conversasAbertas++
        ticketsAbertos++
      } else if (c.status_atendimento === 'em_atendimento') {
        conversasEmAtendimento++
        ticketsAbertos++
      } else if (c.status_atendimento === 'aguardando_cliente') {
        conversasAguardandoCliente++
        ticketsAbertos++
      } else if (c.status_atendimento === 'fechada') {
        conversasFechadas++
      }
      if (c.atendente_id != null) {
        const id = Number(c.atendente_id)
        if (!Number.isNaN(id)) {
          contagemPorAtendente.set(id, (contagemPorAtendente.get(id) || 0) + 1)
        }
      }
    }

    // Atendente mais produtivo: mais conversas atribuídas
    let atendenteMaisProdutivo = null
    if (contagemPorAtendente.size > 0) {
      const idsAtendentes = Array.from(contagemPorAtendente.keys())
      const { data: usuarios, error: errUsers } = await supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', idsAtendentes)
      if (errUsers) throw errUsers

      let melhorId = null
      let melhorTotal = -1
      for (const [id, total] of contagemPorAtendente.entries()) {
        if (total > melhorTotal) {
          melhorTotal = total
          melhorId = id
        }
      }
      if (melhorId != null) {
        const usuario = (usuarios || []).find((u) => Number(u.id) === Number(melhorId)) || null
        atendenteMaisProdutivo = usuario
          ? { id: usuario.id, nome: usuario.nome || 'Sem nome', totalConversas: melhorTotal }
          : { id: melhorId, nome: 'Sem nome', totalConversas: melhorTotal }
      }
    }

    // 3) Mensagens: tempo médio da 1ª resposta + SLA + volume
    const { data: mensagens, error: errMensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])

    if (errMensagens) throw errMensagens

    // Agrupa mensagens por conversa para calcular 1ª mensagem do cliente (in)
    // e 1ª resposta do atendente (out) APÓS a primeira in.
    const mensagensPorConversa = new Map() // conversa_id -> array de msgs
    let mensagensRecebidas = 0
    let mensagensEnviadas = 0

    for (const m of mensagens || []) {
      const convId = m.conversa_id
      const ts = m?.criado_em ? new Date(m.criado_em).getTime() : NaN
      if (!convId || Number.isNaN(ts)) continue

      if (m.direcao === 'in') {
        mensagensRecebidas++
      } else if (m.direcao === 'out') {
        mensagensEnviadas++
      }

      if (!mensagensPorConversa.has(convId)) {
        mensagensPorConversa.set(convId, [])
      }
      mensagensPorConversa.get(convId).push({ ts, direcao: m.direcao })
    }

    let somaMinutosPrimeiraResposta = 0
    let conversasComResposta = 0
    let conversasDentroSla = 0
    let conversasComCliente = 0

    for (const [convId, arr] of mensagensPorConversa.entries()) {
      if (!Array.isArray(arr) || arr.length === 0) continue
      // ordena cronologicamente
      arr.sort((a, b) => a.ts - b.ts)

      const primeiraInMsg = arr.find((m) => m.direcao === 'in')
      if (!primeiraInMsg) continue
      conversasComCliente++

      const primeiraOutMsg = arr.find(
        (m) => m.direcao === 'out' && m.ts >= primeiraInMsg.ts
      )
      if (!primeiraOutMsg) continue

      const diffMin = (primeiraOutMsg.ts - primeiraInMsg.ts) / 60000
      if (diffMin < 0) continue

      somaMinutosPrimeiraResposta += diffMin
      conversasComResposta++
      if (diffMin <= slaMinutos) conversasDentroSla++
    }

    const tempoMedioPrimeiraResposta =
      conversasComResposta > 0 ? somaMinutosPrimeiraResposta / conversasComResposta : null

    const slaPercentualRespondidas =
      conversasComResposta > 0
        ? (conversasDentroSla * 100) / conversasComResposta
        : null

    const slaPercentualTotal =
      conversasComCliente > 0
        ? (conversasDentroSla * 100) / conversasComCliente
        : null

    // 4) Atendimentos hoje (ações na tabela atendimentos)
    let atendimentosHoje = 0
    {
      const { data: atRows, error: errAt } = await supabase
        .from('atendimentos')
        .select('id')
        .eq('company_id', company_id)
        .gte('criado_em', hojeIso)
      if (errAt) {
        // mantém o endpoint funcionando mesmo se a tabela ainda não existir
        console.warn('metrics: erro ao ler atendimentosHoje:', errAt.message || errAt)
      } else {
        atendimentosHoje = atRows?.length || 0
      }
    }

    return res.json({
      atendimentosHoje,
      conversasHoje,
      totalConversas,
      conversasAbertas,
      conversasEmAtendimento,
      conversasAguardandoCliente,
      conversasFechadas,
      tempoMedioPrimeiraResposta,
      slaPercentualRespondidas,
      slaPercentualTotal,
      atendenteMaisProdutivo,
      ticketsAbertos,
      mensagensRecebidas,
      mensagensEnviadas,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular métricas do dashboard' })
  }
}

// GET /dashboard/metrics-avancadas — volume_enviado, volume_recebido, taxa_resposta_24h, etc.
exports.metricsAvancadas = async (req, res) => {
  if (!isEnabled(FLAGS.FEATURE_METRICAS_AVANCADAS)) {
    return res.status(403).json({ error: 'Métricas avançadas não estão habilitadas' })
  }
  const { company_id } = req.user
  const rangeDays = Math.min(Math.max(Number(req.query.range_days) || 7, 1), 365)
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - rangeDays)
  const fromIso = fromDate.toISOString()
  const toIso = new Date().toISOString()

  try {
    const { data: mensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .gte('criado_em', fromIso)
      .lte('criado_em', toIso)

    let volume_enviado = 0
    let volume_recebido = 0
    const conversasPorHora = {}
    const setoresAcionados = {}

    for (const m of mensagens || []) {
      if (m.direcao === 'out') volume_enviado++
      else volume_recebido++

      const d = m.criado_em ? new Date(m.criado_em) : null
      if (d) {
        const h = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}:00`
        conversasPorHora[h] = (conversasPorHora[h] || 0) + 1
      }
    }

    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, departamento_id, criado_em')
      .eq('company_id', company_id)
      .gte('criado_em', fromIso)

    const { data: deps } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', company_id)
    const depMap = {}
    ;(deps || []).forEach((d) => { depMap[d.id] = d.nome })

    for (const c of conversas || []) {
      if (c.departamento_id != null) {
        const nome = depMap[c.departamento_id] || 'Outros'
        setoresAcionados[nome] = (setoresAcionados[nome] || 0) + 1
      }
    }

    const setores_mais_acionados = Object.entries(setoresAcionados)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)

    const horario_pico = Object.entries(conversasPorHora)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null

    const hojeMenos24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: msgs24h } = await supabase
      .from('mensagens')
      .select('conversa_id, direcao, criado_em')
      .eq('company_id', company_id)
      .gte('criado_em', hojeMenos24h)
      .in('direcao', ['in', 'out'])

    const convsComIn24h = new Set()
    const convsComOut24h = new Set()
    for (const m of msgs24h || []) {
      if (m.direcao === 'in') convsComIn24h.add(m.conversa_id)
      if (m.direcao === 'out') convsComOut24h.add(m.conversa_id)
    }
    let taxa_resposta_24h = null
    if (convsComIn24h.size > 0) {
      let respondidas = 0
      for (const cid of convsComIn24h) {
        if (convsComOut24h.has(cid)) respondidas++
      }
      taxa_resposta_24h = Math.round((respondidas / convsComIn24h.size) * 100)
    }

    const { data: novosContatos } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .gte('criado_em', fromIso)
      .is('departamento_id', null)
    const conversas_novos_contatos = novosContatos?.length || 0

    const { data: alertasSla } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .in('status_atendimento', ['aberta', 'em_atendimento'])
    const alertas_recentes = alertasSla?.length || 0

    return res.json({
      volume_enviado,
      volume_recebido,
      taxa_resposta_24h,
      conversas_novos_contatos,
      setores_mais_acionados,
      horario_pico,
      alertas_recentes,
      range_days: rangeDays,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular métricas avançadas' })
  }
}

// =====================================================
// DEPARTAMENTOS (setores: Financeiro, Suporte, Comercial)
// =====================================================
exports.listarDepartamentos = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('departamentos')
      .select('id, nome, criado_em')
      .eq('company_id', company_id)
      .order('nome')
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar departamentos' })
  }
}

exports.criarDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .insert({ company_id, nome: nome.trim() })
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar departamento' })
  }
}

exports.atualizarDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .update({ nome: nome.trim() })
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    if (!data) return res.status(404).json({ error: 'Departamento não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar departamento' })
  }
}

exports.excluirDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const depId = Number(id)

    // Verifica se há usuários vinculados a este departamento
    const { data: usuariosNoSetor } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (usuariosNoSetor && usuariosNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${usuariosNoSetor.length} usuário(s) ainda vinculado(s) a este setor. Reatribua-os em Configurações > Usuários antes de excluir.`
      })
    }

    // Verifica conversas no setor
    const { data: conversasNoSetor } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (conversasNoSetor && conversasNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: existem ${conversasNoSetor.length} conversa(s) neste setor. Transfira-as para outro setor antes de excluir.`
      })
    }

    // Verifica respostas salvas e regras automáticas vinculadas
    const { data: respostasVinculadas } = await supabase
      .from('respostas_salvas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (respostasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${respostasVinculadas.length} resposta(s) salva(s) vinculada(s). Altere ou remova o vínculo em Configurações > Respostas salvas.`
      })
    }

    const { data: regrasVinculadas } = await supabase
      .from('regras_automaticas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (regrasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${regrasVinculadas.length} regra(s) automática(s) vinculada(s). Altere em IA > Respostas automáticas.`
      })
    }

    const { error } = await supabase
      .from('departamentos')
      .delete()
      .eq('id', depId)
      .eq('company_id', company_id)
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir departamento' })
  }
}

// =====================================================
// RESPOSTAS SALVAS (pessoais por usuário; setor opcional)
// =====================================================
async function getDepartamentoDaEmpresa(company_id, departamento_id) {
  const depId = Number(departamento_id)
  if (!Number.isFinite(depId) || depId <= 0) return null
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', Number(company_id))
    .eq('id', depId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

exports.listarGruposDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const departamento = await getDepartamentoDaEmpresa(company_id, req.params.id)
    if (!departamento) return res.status(404).json({ error: 'Departamento nao encontrado' })

    const { data: vinculos, error: errVinculos } = await supabase
      .from('departamento_grupos')
      .select('conversa_id')
      .eq('company_id', Number(company_id))
      .eq('departamento_id', Number(departamento.id))
    if (errVinculos) return res.status(500).json({ error: errVinculos.message })

    const vinculadosSet = new Set((vinculos || []).map((v) => Number(v.conversa_id)))

    const { data: grupos, error } = await supabase
      .from('conversas')
      .select('id, telefone, tipo, nome_grupo, foto_grupo, criado_em, ultima_atividade')
      .eq('company_id', Number(company_id))
      .eq('tipo', 'grupo')
      .order('nome_grupo', { ascending: true, nullsFirst: false })

    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const rows = (grupos || [])
      .filter(isGroupRow)
      .map((g) => ({
        id: g.id,
        telefone: g.telefone,
        tipo: g.tipo,
        nome_grupo: g.nome_grupo,
        foto_grupo: g.foto_grupo,
        criado_em: g.criado_em,
        ultima_atividade: g.ultima_atividade,
        vinculado: vinculadosSet.has(Number(g.id)),
      }))

    return res.json({ departamento, grupos: rows })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar grupos do departamento' })
  }
}

exports.atualizarGruposDepartamento = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    const departamento = await getDepartamentoDaEmpresa(company_id, req.params.id)
    if (!departamento) return res.status(404).json({ error: 'Departamento nao encontrado' })

    const conversaIds = normalizePositiveIds(req.body?.conversa_ids)

    if (conversaIds.length > 0) {
      const { data: conversas, error: errConversas } = await supabase
        .from('conversas')
        .select('id, tipo, telefone')
        .eq('company_id', Number(company_id))
        .in('id', conversaIds)
      if (errConversas) return res.status(500).json({ error: errConversas.message })

      const byId = new Map((conversas || []).map((c) => [Number(c.id), c]))
      const invalid = conversaIds.filter((id) => !isGroupRow(byId.get(Number(id))))
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'A lista contem conversa que nao e grupo desta empresa' })
      }
    }

    const { error: delErr } = await supabase
      .from('departamento_grupos')
      .delete()
      .eq('company_id', Number(company_id))
      .eq('departamento_id', Number(departamento.id))
    if (delErr) return res.status(500).json({ error: delErr.message })

    if (conversaIds.length > 0) {
      const rows = conversaIds.map((conversa_id) => ({
        company_id: Number(company_id),
        departamento_id: Number(departamento.id),
        conversa_id,
        criado_por: Number(usuario_id) || null,
      }))
      const { error: insertErr } = await supabase
        .from('departamento_grupos')
        .insert(rows)
      if (insertErr) return res.status(500).json({ error: insertErr.message })
    }

    return res.json({ ok: true, departamento_id: Number(departamento.id), conversa_ids: conversaIds })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar grupos do departamento' })
  }
}

async function validarDepartamentoEmpresa(company_id, departamento_id) {
  if (departamento_id == null || departamento_id === '') return null
  const depId = Number(departamento_id)
  if (!Number.isFinite(depId) || depId <= 0) return { error: 'Setor inválido' }
  const { data: dep, error } = await supabase
    .from('departamentos')
    .select('id')
    .eq('id', depId)
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!dep) return { error: 'Setor não encontrado nesta empresa' }
  return { departamento_id: depId }
}

function isAdminOrSupervisor(user) {
  const perfil = String(user?.perfil || '').toLowerCase()
  return perfil === 'admin' || perfil === 'administrador' || perfil === 'supervisor'
}

async function buscarRespostaSalvaGerenciavel(company_id, id) {
  const { data, error } = await supabase
    .from('respostas_salvas')
    .select('id, usuario_id, departamento_id')
    .eq('id', id)
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { notFound: true }
  return { resposta: data }
}

function podeGerenciarRespostaSalva(resposta, userId, user) {
  if (resposta?.departamento_id == null) {
    return Number(resposta.usuario_id) === userId || isAdminOrSupervisor(user)
  }
  return Number(resposta.usuario_id) === userId
}

exports.listarRespostasSalvas = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { departamento_id, contexto } = req.query
    const contextoAtendimento = String(contexto || '').toLowerCase() === 'atendimento'
    let q = supabase
      .from('respostas_salvas')
      // NÃO embutir departamentos aqui: em alguns schemas o PostgREST detecta mais de 1 relacionamento
      // entre respostas_salvas e departamentos e retorna:
      // "Could not embed because more than one relationship was found..."
      .select('id, titulo, texto, departamento_id, usuario_id, criado_em')
      .eq('company_id', company_id)
      .or(`departamento_id.is.null,usuario_id.eq.${userId}`)
      .order('titulo')
    if (departamento_id != null && departamento_id !== '') {
      const depId = Number(departamento_id)
      if (Number.isFinite(depId) && depId > 0) {
        q = q.or(`departamento_id.eq.${depId},departamento_id.is.null`)
      }
    } else if (contextoAtendimento) {
      // Conversa sem setor: apenas respostas globais (não expor vinculadas a setor)
      q = q.is('departamento_id', null)
    }
    const { data, error } = await q
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const list = Array.isArray(data) ? data : []

    // Resolve nomes de departamento manualmente (evita embed ambíguo)
    const depIds = [...new Set(list.map((r) => r?.departamento_id).filter((id) => id != null))]
    let depMap = {}
    if (depIds.length > 0) {
      const { data: deps, error: errDeps } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', depIds)
      if (!errDeps && Array.isArray(deps)) {
        deps.forEach((d) => {
          if (d?.id != null) depMap[String(d.id)] = d
        })
      }
    }

    const out = list.map((r) => ({
      ...r,
      departamentos: r?.departamento_id != null ? (depMap[String(r.departamento_id)] ? { nome: depMap[String(r.departamento_id)].nome } : null) : null,
    }))

    return res.json(out)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar respostas salvas' })
  }
}

const LIMITE_RESPOSTAS_ATENDENTE = 5

exports.criarRespostaSalva = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { titulo, texto, departamento_id } = req.body
    const tituloTrim = String(titulo || '').trim()
    const textoTrim = String(texto || '').trim()
    if (!tituloTrim || !textoTrim) return res.status(400).json({ error: 'titulo e texto obrigatórios' })
    if (tituloTrim.length > 255) return res.status(400).json({ error: 'titulo deve ter no máximo 255 caracteres' })

    // Atendentes têm limite de respostas salvas próprias
    if (!isAdminOrSupervisor(req.user)) {
      const { count, error: countErr } = await supabase
        .from('respostas_salvas')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company_id)
        .eq('usuario_id', userId)
      if (countErr) {
        console.error('[respostas_salvas] count error:', countErr.message)
      } else if ((count ?? 0) >= LIMITE_RESPOSTAS_ATENDENTE) {
        return res.status(400).json({
          error: `Limite de ${LIMITE_RESPOSTAS_ATENDENTE} respostas salvas atingido. Exclua uma existente antes de criar outra.`,
          code: 'LIMITE_RESPOSTAS_ATINGIDO',
          limite: LIMITE_RESPOSTAS_ATENDENTE,
          total: count,
        })
      }
    }

    const depCheck = await validarDepartamentoEmpresa(company_id, departamento_id)
    if (depCheck?.error) return res.status(400).json({ error: depCheck.error })
    const depId = depCheck?.departamento_id ?? null
    const { data, error } = await supabase
      .from('respostas_salvas')
      .insert({
        company_id,
        usuario_id: userId,
        titulo: tituloTrim,
        texto: textoTrim,
        departamento_id: depId,
      })
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar resposta salva' })
  }
}

exports.atualizarRespostaSalva = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { id } = req.params
    const { titulo, texto, departamento_id } = req.body
    const update = {}
    if (titulo !== undefined) {
      const tituloTrim = String(titulo || '').trim()
      if (!tituloTrim) return res.status(400).json({ error: 'titulo obrigatório' })
      if (tituloTrim.length > 255) return res.status(400).json({ error: 'titulo deve ter no máximo 255 caracteres' })
      update.titulo = tituloTrim
    }
    if (texto !== undefined) {
      const textoTrim = String(texto || '').trim()
      if (!textoTrim) return res.status(400).json({ error: 'texto obrigatório' })
      update.texto = textoTrim
    }
    if (departamento_id !== undefined) {
      const depCheck = await validarDepartamentoEmpresa(company_id, departamento_id)
      if (depCheck?.error) return res.status(400).json({ error: depCheck.error })
      const depId = depCheck?.departamento_id ?? null
      update.departamento_id = depId
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' })
    }
    const found = await buscarRespostaSalvaGerenciavel(company_id, id)
    if (found?.error) return res.status(500).json({ error: found.error })
    if (found?.notFound) return res.status(404).json({ error: 'Resposta não encontrada' })
    if (!podeGerenciarRespostaSalva(found.resposta, userId, req.user)) {
      return res.status(403).json({ error: 'Sem permissão para editar esta resposta' })
    }
    const { data, error } = await supabase
      .from('respostas_salvas')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    if (!data) return res.status(404).json({ error: 'Resposta não encontrada' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar resposta salva' })
  }
}

exports.excluirRespostaSalva = async (req, res) => {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { id } = req.params
    const found = await buscarRespostaSalvaGerenciavel(company_id, id)
    if (found?.error) return res.status(500).json({ error: found.error })
    if (found?.notFound) return res.status(404).json({ error: 'Resposta não encontrada' })
    if (!podeGerenciarRespostaSalva(found.resposta, userId, req.user)) {
      return res.status(403).json({ error: 'Sem permissão para excluir esta resposta' })
    }
    const { error } = await supabase
      .from('respostas_salvas')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir resposta salva' })
  }
}

// =====================================================
// RELATÓRIO COMPLETO (conversas + cliente + observações + tags + atendente)
// =====================================================
async function buildRelatorioConversas(company_id, filters = {}) {
  const { data: conversas, error } = await supabase
    .from('conversas')
    .select(`
      id, telefone, status_atendimento, criado_em, atendente_id, departamento_id,
      clientes!conversas_cliente_fk ( nome, observacoes ),
      conversa_tags ( tag_id, tags ( id, nome ) )
    `)
    .eq('company_id', company_id)

  if (error) throw error
  let list = conversas || []

  const atendenteNomeMap = await fetchUsuariosNomeMap(
    company_id,
    list.map((c) => c?.atendente_id)
  )

  if (filters.data_inicio) list = list.filter(c => new Date(c.criado_em) >= new Date(filters.data_inicio))
  if (filters.data_fim) {
    const fim = new Date(filters.data_fim)
    fim.setHours(23, 59, 59, 999)
    list = list.filter(c => new Date(c.criado_em) <= fim)
  }
  if (filters.status_atendimento) list = list.filter(c => c.status_atendimento === filters.status_atendimento)
  if (filters.atendente_id) list = list.filter(c => Number(c.atendente_id) === Number(filters.atendente_id))
  if (filters.departamento_id) list = list.filter(c => Number(c.departamento_id) === Number(filters.departamento_id))

  const conversaIds = list.map(c => c.id)
  if (conversaIds.length === 0) return []

  // Resolve nomes de setor sem embed (evita relacionamento ambíguo)
  const depIds = [...new Set(list.map((c) => c?.departamento_id).filter((id) => id != null))]
  let depMap = {}
  if (depIds.length > 0) {
    const { data: deps } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', company_id)
      .in('id', depIds)
    if (Array.isArray(deps)) {
      deps.forEach((d) => {
        if (d?.id != null) depMap[String(d.id)] = d?.nome || null
      })
    }
  }

  const { data: mensagens } = await supabase
    .from('mensagens')
    .select('conversa_id, texto, criado_em, direcao')
    .eq('company_id', company_id)
    .in('conversa_id', conversaIds)
    .order('criado_em', { ascending: false })

  const ultimaPorConversa = {}
  const ultimaInPorConversa = {}
  ;(mensagens || []).forEach(m => {
    if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
    if (m.direcao === 'in' && !ultimaInPorConversa[m.conversa_id]) ultimaInPorConversa[m.conversa_id] = m
  })

  const now = Date.now()
  return list.map(c => {
    const ultima = ultimaPorConversa[c.id]
    const ultimaIn = ultimaInPorConversa[c.id]
    // Tempo sem responder: só quando a ÚLTIMA mensagem foi do cliente (aguardando resposta)
    let tempo_sem_responder_min = null
    if (ultima?.direcao === 'in' && ultimaIn?.criado_em) {
      tempo_sem_responder_min = Math.round((now - new Date(ultimaIn.criado_em).getTime()) / 60000)
    }
    const tags = (c.conversa_tags || []).map(ct => ct.tags).filter(Boolean)
    return {
      id: c.id,
      cliente_nome: getDisplayName(c.clientes) || '—',
      telefone: c.telefone,
      observacoes: c.clientes?.observacoes || '',
      setor: c?.departamento_id != null ? (depMap[String(c.departamento_id)] || '—') : '—',
      status_atendimento: c.status_atendimento,
      atendente_nome: atendenteNomeMap[String(c?.atendente_id)] || '—',
      tags: tags.map(t => t.nome).join(', '),
      criado_em: c.criado_em,
      ultima_mensagem: ultima?.texto?.slice(0, 200) || '—',
      ultima_mensagem_em: ultima?.criado_em || null,
      tempo_sem_responder_min,
    }
  })
}

exports.relatorioConversas = async (req, res) => {
  try {
    const { company_id } = req.user
    const filters = {
      data_inicio: req.query.data_inicio,
      data_fim: req.query.data_fim,
      status_atendimento: req.query.status_atendimento,
      atendente_id: req.query.atendente_id,
      departamento_id: req.query.departamento_id,
    }
    const data = await buildRelatorioConversas(company_id, filters)
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao gerar relatório' })
  }
}

// =====================================================
// RELATÓRIO (mensagens por dia/tipo/direção) — simples e claro
// =====================================================
exports.relatorioMensagens = async (req, res) => {
  try {
    const { company_id } = req.user
    const data_inicio = req.query.data_inicio || null
    const data_fim = req.query.data_fim || null

    let q = supabase
      .from('mensagens')
      .select('criado_em, direcao, tipo')
      .eq('company_id', company_id)
      // Relatório de mensagens do WhatsApp: nota interna não é mensagem de WhatsApp.
      .in('direcao', REAL_MESSAGE_DIRECOES)
      .order('criado_em', { ascending: true })

    if (data_inicio) q = q.gte('criado_em', new Date(data_inicio).toISOString())
    if (data_fim) {
      const fim = new Date(data_fim)
      fim.setHours(23, 59, 59, 999)
      q = q.lte('criado_em', fim.toISOString())
    }

    const { data: rows, error } = await q
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const byDay = {}
    for (const r of rows || []) {
      const d = r?.criado_em ? new Date(r.criado_em) : null
      if (!d || Number.isNaN(d.getTime())) continue
      const key = d.toISOString().slice(0, 10) // YYYY-MM-DD
      if (!byDay[key]) {
        byDay[key] = {
          dia: key,
          total: 0,
          in: 0,
          out: 0,
          texto: 0,
          audio: 0,
          imagem: 0,
          video: 0,
          sticker: 0,
          arquivo: 0,
        }
      }
      const agg = byDay[key]
      agg.total++
      if (r?.direcao === 'in') agg.in++
      if (r?.direcao === 'out') agg.out++

      const t = String(r?.tipo || 'texto').toLowerCase()
      if (t === 'audio') agg.audio++
      else if (t === 'imagem') agg.imagem++
      else if (t === 'video') agg.video++
      else if (t === 'sticker') agg.sticker++
      else if (t === 'arquivo') agg.arquivo++
      else agg.texto++
    }

    const list = Object.values(byDay).sort((a, b) => a.dia.localeCompare(b.dia))
    return res.json(list)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao gerar relatório de mensagens' })
  }
}

function escapeCsv (str) {
  if (str == null) return ''
  return String(str).replace(/;/g, ',').replace(/\n/g, ' ')
}

exports.exportRelatorio = async (req, res) => {
  try {
    const { company_id } = req.user
    const format = (req.query.format || 'csv').toLowerCase()
    const filters = {
      data_inicio: req.query.data_inicio,
      data_fim: req.query.data_fim,
      status_atendimento: req.query.status_atendimento,
      atendente_id: req.query.atendente_id,
      departamento_id: req.query.departamento_id,
    }
    const data = await buildRelatorioConversas(company_id, filters)

    if (format === 'csv') {
      const header = 'Cliente;Telefone;Observações;Setor;Status;Atendente;Tags;Criado em;Última msg;Tempo sem responder (min)\n'
      const rows = data.map(r =>
        [
          escapeCsv(r.cliente_nome),
          escapeCsv(r.telefone),
          escapeCsv(r.observacoes),
          escapeCsv(r.setor),
          escapeCsv(r.status_atendimento),
          escapeCsv(r.atendente_nome),
          escapeCsv(r.tags),
          r.criado_em ? new Date(r.criado_em).toLocaleString('pt-BR') : '',
          escapeCsv(r.ultima_mensagem),
          r.tempo_sem_responder_min != null ? r.tempo_sem_responder_min : '',
        ].join(';')
      ).join('\n')
      const csv = '\uFEFF' + header + rows
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.csv')
      return res.send(csv)
    }

    if (format === 'xlsx' || format === 'excel') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Conversas', { views: [{ state: 'frozen', ySplit: 1 }] })
      const cols = [
        { header: 'Cliente', key: 'cliente_nome', width: 22 },
        { header: 'Telefone', key: 'telefone', width: 16 },
        { header: 'Observações', key: 'observacoes', width: 30 },
        { header: 'Setor', key: 'setor', width: 14 },
        { header: 'Status', key: 'status_atendimento', width: 14 },
        { header: 'Atendente', key: 'atendente_nome', width: 18 },
        { header: 'Tags', key: 'tags', width: 20 },
        { header: 'Criado em', key: 'criado_em', width: 18 },
        { header: 'Última msg', key: 'ultima_mensagem', width: 35 },
        { header: 'Tempo sem responder (min)', key: 'tempo_sem_responder_min', width: 14 },
      ]
      sheet.columns = cols
      sheet.getRow(1).font = { bold: true }
      data.forEach(r => {
        sheet.addRow({
          cliente_nome: r.cliente_nome || '',
          telefone: r.telefone || '',
          observacoes: (r.observacoes || '').slice(0, 32000),
          setor: r.setor || '',
          status_atendimento: r.status_atendimento || '',
          atendente_nome: r.atendente_nome || '',
          tags: r.tags || '',
          criado_em: r.criado_em ? new Date(r.criado_em) : null,
          ultima_mensagem: (r.ultima_mensagem || '').slice(0, 32000),
          tempo_sem_responder_min: r.tempo_sem_responder_min != null ? r.tempo_sem_responder_min : '',
        })
      })
      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.xlsx')
      return res.send(Buffer.from(buffer))
    }

    if (format === 'pdf') {
      const doc = new PDFDocument({ margin: 30, size: 'A4' })
      const chunks = []
      doc.on('data', chunk => chunks.push(chunk))
      doc.on('end', () => res.send(Buffer.concat(chunks)))
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.pdf')
      doc.fontSize(14).text('Relatório de conversas', { align: 'center' })
      doc.moveDown(0.5)
      doc.fontSize(9)
      const headers = ['Cliente', 'Telefone', 'Setor', 'Status', 'Atendente', 'Criado em', 'Min sem resp.']
      const colWidths = [80, 75, 50, 50, 70, 75, 45]
      let y = doc.y
      headers.forEach((h, i) => {
        doc.text(h, 30 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, { width: colWidths[i], continued: false })
      })
      y += 18
      doc.moveTo(30, y).lineTo(570, y).stroke()
      y += 8
      for (const r of data) {
        if (y > 750) {
          doc.addPage()
          y = 30
        }
        const row = [
          (r.cliente_nome || '—').slice(0, 18),
          (r.telefone || '—').slice(0, 14),
          (r.setor || '—').slice(0, 10),
          (r.status_atendimento || '—').slice(0, 12),
          (r.atendente_nome || '—').slice(0, 14),
          r.criado_em ? new Date(r.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
          r.tempo_sem_responder_min != null ? String(r.tempo_sem_responder_min) : '—',
        ]
        let x = 30
        row.forEach((cell, i) => {
          doc.text(cell, x, y, { width: colWidths[i], ellipsis: true })
          x += colWidths[i]
        })
        y += 16
      }
      doc.end()
      return
    }

    res.setHeader('Content-Type', 'application/json')
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao exportar' })
  }
}

// =====================================================
// SLA: CONFIG (minutos sem resposta para alerta)
// =====================================================
exports.getSlaConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const config = await slaCalculationService.loadSlaConfig(company_id)
    const businessInfo = await slaCalculationService.loadSlaBusinessSchedule(company_id, config)
    return res.json({
      sla_minutos_sem_resposta: config.sla_minutos_sem_resposta,
      sla_meta_percentual: config.sla_meta_percentual,
      sla_usar_horario_comercial: config.sla_usar_horario_comercial,
      sla_contar_bot_como_resposta: config.sla_contar_bot_como_resposta,
      metas_departamentos: config.metas_departamentos,
      metas_usuarios: config.metas_usuarios,
      horario_comercial: businessInfo,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao obter config SLA' })
  }
}

exports.setSlaConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const saved = await slaCalculationService.saveSlaConfig(company_id, req.body || {})
    const businessInfo = await slaCalculationService.loadSlaBusinessSchedule(company_id, saved)
    return res.json({
      sla_minutos_sem_resposta: saved.sla_minutos_sem_resposta,
      sla_meta_percentual: saved.sla_meta_percentual,
      sla_usar_horario_comercial: saved.sla_usar_horario_comercial,
      sla_contar_bot_como_resposta: saved.sla_contar_bot_como_resposta,
      metas_departamentos: saved.metas_departamentos,
      metas_usuarios: saved.metas_usuarios,
      horario_comercial: businessInfo,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar config SLA' })
  }
}

// =====================================================
// SLA: ALERTAS (conversas onde cliente está X min sem resposta)
// =====================================================
exports.getSlaAlertas = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data: emp } = await supabase.from('empresas').select('sla_minutos_sem_resposta').eq('id', company_id).single()
    const limiteMin = emp?.sla_minutos_sem_resposta ?? 30

    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, telefone, status_atendimento, criado_em, atendente_id, clientes!conversas_cliente_fk ( nome )')
      .eq('company_id', company_id)
      .in('status_atendimento', ['aberta', 'em_atendimento'])

    const atendenteNomeMap = await fetchUsuariosNomeMap(
      company_id,
      (conversas || []).map((c) => c?.atendente_id)
    )

    const { data: mensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .order('criado_em', { ascending: false })

    const ultimaInPorConversa = {}
    ;(mensagens || []).forEach(m => {
      if (m.direcao === 'in' && !ultimaInPorConversa[m.conversa_id]) ultimaInPorConversa[m.conversa_id] = m
    })

    const now = Date.now()
    const alertas = []
    ;(conversas || []).forEach(c => {
      const ultimaIn = ultimaInPorConversa[c.id]
      if (!ultimaIn) return
      const minSemResponder = Math.floor((now - new Date(ultimaIn.criado_em).getTime()) / 60000)
      if (minSemResponder >= limiteMin) {
        alertas.push({
          conversa_id: c.id,
          cliente_nome: getDisplayName(c.clientes) || c.telefone,
          telefone: c.telefone,
          atendente_nome: atendenteNomeMap[String(c?.atendente_id)] || '—',
          tempo_sem_responder_min: minSemResponder,
          limite_min: limiteMin,
        })
      }
    })
    alertas.sort((a, b) => b.tempo_sem_responder_min - a.tempo_sem_responder_min)
    return res.json({ limite_min: limiteMin, alertas })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar alertas SLA' })
  }
}

exports.slaResumo = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await buildSlaAnalytics(company_id, req.query)
    return res.json({
      periodo: data.periodo,
      limite_min: data.limite_min,
      meta_percentual: data.meta_percentual,
      config: data.config,
      horario_comercial: data.horario_comercial,
      resumo: data.resumo,
      tendencia: data.tendencia,
      por_tipo: data.por_tipo,
      ranking_atendentes: data.ranking_atendentes,
      ranking_atendentes_melhor: data.ranking_atendentes_melhor,
      ranking_atendentes_violacoes: data.ranking_atendentes_violacoes,
      ranking_setores: data.ranking_setores,
      horarios_maior_violacao: data.horarios_maior_violacao,
      dias_semana_pior_sla: data.dias_semana_pior_sla,
      violacoes: data.violacoes,
      sem_resposta: data.sem_resposta,
      dados_insuficientes: data.dados_insuficientes,
      criticas_sem_resposta: data.criticas_sem_resposta,
      conversas_detalhadas: data.conversas_detalhadas,
      reabertura: data.reabertura,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular SLA' })
  }
}

exports.slaDiaria = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await buildSlaAnalytics(company_id, req.query)
    return res.json({
      periodo: data.periodo,
      limite_min: data.limite_min,
      meta_percentual: data.meta_percentual,
      config: data.config,
      horario_comercial: data.horario_comercial,
      resumo: data.resumo,
      tendencia: data.tendencia,
      diario: data.diario,
      melhor_dia: data.melhor_dia,
      pior_dia: data.pior_dia,
      dias_abaixo_meta: data.dias_abaixo_meta,
      ranking_atendentes: data.ranking_atendentes,
      ranking_setores: data.ranking_setores,
      dia_detalhe: data.dia_filtro ? {
        dia: data.dia_filtro,
        violacoes: data.violacoes,
        sem_resposta: data.sem_resposta,
        dados_insuficientes: data.dados_insuficientes,
        conversas_detalhadas: data.conversas_detalhadas,
      } : null,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular SLA diária' })
  }
}

exports.slaValidacao = async (req, res) => {
  try {
    const { company_id } = req.user
    const conversaId = req.params.conversa_id || req.query.conversa_id
    const result = await slaCalculationService.validateConversaSla(company_id, conversaId)
    if (result.error) return res.status(400).json({ error: result.error })
    return res.json(result)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao validar SLA da conversa' })
  }
}

function escapeCsvCell(value) {
  return String(value ?? '').replace(/;/g, ',').replace(/\n/g, ' ')
}

exports.exportSla = async (req, res) => {
  try {
    const { company_id } = req.user
    const format = (req.query.format || 'csv').toLowerCase()
    const tipo = String(req.query.tipo || 'detalhado').toLowerCase()
    const data = await buildSlaAnalytics(company_id, req.query)
    const exportRows = slaCalculationService.flattenSlaExportRows(data)

    if (tipo === 'resumo') {
      const resumoRows = [
        ['Período início', data.periodo?.data_inicio],
        ['Período fim', data.periodo?.data_fim],
        ['Meta minutos (global)', data.limite_min],
        ['Meta percentual', data.meta_percentual],
        ['Modo contagem', data.horario_comercial?.modo_contagem],
        ['Total analisadas', data.resumo?.total_analisadas],
        ['Dentro SLA', data.resumo?.dentro_sla],
        ['Fora SLA', data.resumo?.fora_sla],
        ['Sem resposta', data.resumo?.sem_resposta],
        ['Dados insuficientes', data.resumo?.dados_insuficientes],
        ['Percentual cumprido', data.resumo?.percentual_cumprido],
        ['Tempo médio (min)', data.resumo?.tempo_medio_primeira_resposta_min],
        ['Pior tempo (min)', data.resumo?.pior_tempo_resposta_min],
        ['Melhor tempo (min)', data.resumo?.melhor_tempo_resposta_min],
      ]
      if (format === 'xlsx' || format === 'excel') {
        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet('Resumo SLA')
        resumoRows.forEach((row) => sheet.addRow(row))
        const buffer = await workbook.xlsx.writeBuffer()
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename=sla-resumo.xlsx')
        return res.send(Buffer.from(buffer))
      }
      const csv = '\uFEFF' + resumoRows.map((row) => row.map(escapeCsvCell).join(';')).join('\n')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename=sla-resumo.csv')
      return res.send(csv)
    }

    const header = ['Tipo SLA', 'Status SLA', 'Cliente', 'Telefone', 'Atendente', 'Setor', 'Primeira msg cliente', 'Primeira resposta', 'Tempo (min)', 'Meta (min)', 'Origem meta', 'Tipo resposta', 'Status conversa', 'Conversa ID']
    const body = exportRows.map((r) => [
      r.tipo_sla,
      r.status_sla,
      r.cliente,
      r.telefone,
      r.atendente,
      r.setor,
      r.primeira_msg_cliente ? new Date(r.primeira_msg_cliente).toLocaleString('pt-BR') : '',
      r.primeira_resposta ? new Date(r.primeira_resposta).toLocaleString('pt-BR') : '',
      r.tempo_min,
      r.limite_min,
      r.meta_origem,
      r.tipo_resposta,
      r.status_conversa,
      r.conversa_id,
    ])

    if (format === 'xlsx' || format === 'excel') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('SLA Detalhado', { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.addRow(header)
      sheet.getRow(1).font = { bold: true }
      body.forEach((row) => sheet.addRow(row))
      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename=sla-detalhado.xlsx')
      return res.send(Buffer.from(buffer))
    }

    const csv = '\uFEFF' + [header, ...body].map((row) => row.map(escapeCsvCell).join(';')).join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=sla-detalhado.csv')
    return res.send(csv)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao exportar SLA' })
  }
}
