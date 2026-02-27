'use strict'

/**
 * aiDashboardService.js
 *
 * Assistente IA do Dashboard ZapERP.
 * - Usa Supabase client (mesmo padrão do restante do projeto).
 * - NÃO permite SQL livre: modelo apenas classifica a pergunta em um intent
 *   permitido; aexecução dos dados é feita por funções pré-definidas aqui.
 * - Todas as queries filtram por company_id (multi-tenant rigoroso).
 */

const { z } = require('zod')
const { client: openai } = require('./openaiClient')
const supabase = require('../config/supabase')

// ── Configuração ──────────────────────────────────────────────────────────────
const AI_MODEL = () => process.env.AI_MODEL || 'gpt-4o-mini'

/** Limita period_days ao intervalo válido 1–365 (default 7). */
function clampDays(n) {
  const x = Math.trunc(Number(n))
  if (!Number.isFinite(x) || x < 1) return 7
  return Math.min(365, x)
}

// ── Schema de intent (zod) ────────────────────────────────────────────────────
const IntentSchema = z.object({
  intent: z.enum([
    'METRICS_OVERVIEW',
    'ATENDENTE_MAIS_RAPIDO',
    'ATENDENTE_MAIS_LENTO',
    'TOP_ATENDENTES_POR_CONVERSAS',
    'CLIENTES_MAIS_ATIVOS',
    'SLA_ALERTAS',
    'UNKNOWN',
  ]),
  period_days: z.number().int().min(1).max(365).optional(),
})

// ── Classificação da pergunta (1ª chamada à OpenAI) ───────────────────────────
async function classifyQuestion(question) {
  const system = `\
Você é um classificador de perguntas para o Dashboard do ZapERP.
Retorne SOMENTE JSON válido sem texto extra.
Formato: {"intent": "INTENT", "period_days": N}

Intents permitidos:
- METRICS_OVERVIEW: visão geral, resumo, métricas gerais, atendimentos de hoje, tickets abertos, SLA geral
- ATENDENTE_MAIS_RAPIDO: atendente com menor tempo médio de 1ª resposta
- ATENDENTE_MAIS_LENTO: atendente com maior tempo médio de 1ª resposta
- TOP_ATENDENTES_POR_CONVERSAS: ranking de atendentes por número de conversas
- CLIENTES_MAIS_ATIVOS: clientes que mais enviaram mensagens (direcao='in')
- SLA_ALERTAS: alertas de SLA, conversas abertas sem resposta dentro do prazo
- UNKNOWN: qualquer outra coisa

Regra: se "period_days" não for mencionado, use 7.`

  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Pergunta: ${question}` },
    ],
  })

  const raw = resp.choices?.[0]?.message?.content?.trim() || ''
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = { intent: 'UNKNOWN' } }

  const safe = IntentSchema.safeParse(parsed)
  return safe.success ? safe.data : { intent: 'UNKNOWN' }
}

// ── Geração da resposta em texto (2ª chamada à OpenAI) ────────────────────────
async function formatAnswer({ intent, data, question }) {
  const system = `\
Você é um assistente de BI do ZapERP. Responda em português do Brasil.
Regras obrigatórias:
- Seja objetivo e profissional (máximo 3 parágrafos curtos).
- Use APENAS os números presentes no campo "Dados".
- NUNCA invente valores, percentuais ou nomes.
- Se "Dados" for null, vazio ou array vazio, informe que não há dados suficientes no período.
- Não mencione "dados JSON", "intent" ou detalhes técnicos na resposta.`

  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: 0.2,
    max_tokens: 320,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Pergunta: ${question}\nIntenção: ${intent}\nDados: ${JSON.stringify(data)}`,
      },
    ],
  })

  return resp.choices?.[0]?.message?.content?.trim() || 'Não foi possível gerar a resposta.'
}

// ── Helpers internos ──────────────────────────────────────────────────────────

/**
 * Recebe array de mensagens { conversa_id, criado_em, direcao }
 * e retorna Map< conversa_id → msgs[] > ordenado por criado_em ASC.
 */
function buildMsgsByConv(msgs) {
  const map = new Map()
  for (const m of msgs || []) {
    const ts = new Date(m.criado_em).getTime()
    if (!m.conversa_id || Number.isNaN(ts)) continue
    if (!map.has(m.conversa_id)) map.set(m.conversa_id, [])
    map.get(m.conversa_id).push({ ts, direcao: m.direcao })
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts - b.ts)
  return map
}

/**
 * Para um array de mensagens de UMA conversa (ordenado),
 * retorna { diffMin } ou null se não houver par in/out válido.
 */
function calcFirstResponseDiff(msgs) {
  const firstIn = msgs.find((m) => m.direcao === 'in')
  if (!firstIn) return null
  const firstOut = msgs.find((m) => m.direcao === 'out' && m.ts >= firstIn.ts)
  if (!firstOut) return null
  const diffMin = (firstOut.ts - firstIn.ts) / 60000
  return diffMin >= 0 ? diffMin : null
}

// ── Queries de dados (Supabase client — sem SQL livre) ───────────────────────

/** METRICS_OVERVIEW: resumo geral da empresa. */
async function qMetricsOverview(company_id) {
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const hojeIso = hoje.toISOString()

  // Janela de 90 dias para cálculos de tempo (evita buscar histórico inteiro)
  const desde90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  // 1) SLA config da empresa
  const { data: emp } = await supabase
    .from('empresas')
    .select('sla_minutos_sem_resposta')
    .eq('id', company_id)
    .maybeSingle()
  const slaMin = Math.max(1, Math.min(1440, emp?.sla_minutos_sem_resposta ?? 30))

  // 2) Atendimentos hoje — contagem direta (sem trazer dados desnecessários)
  const { count: atendimentosHoje } = await supabase
    .from('atendimentos')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', company_id)
    .gte('criado_em', hojeIso)

  // 3) Conversas — busca somente campos de KPI; PostgREST paginado até 5000
  const { data: convRows, error: errConv } = await supabase
    .from('conversas')
    .select('id, criado_em, status_atendimento')
    .eq('company_id', company_id)
    .order('criado_em', { ascending: false })
    .limit(5000)
  if (errConv) throw errConv

  let conversasHoje = 0, totalConversas = 0, ticketsAbertos = 0, conversasFechadas = 0
  for (const c of convRows || []) {
    totalConversas++
    if (new Date(c.criado_em) >= hoje) conversasHoje++
    if (c.status_atendimento === 'aberta' || c.status_atendimento === 'em_atendimento') ticketsAbertos++
    if (c.status_atendimento === 'fechada') conversasFechadas++
  }
  const taxaConversao = totalConversas > 0
    ? Math.round((conversasFechadas * 100 / totalConversas) * 10) / 10 : 0

  // 4) Volume de mensagens — contagem direta (evita trazer todas as linhas)
  const [{ count: mensagensRecebidas }, { count: mensagensEnviadas }] = await Promise.all([
    supabase.from('mensagens').select('id', { count: 'exact', head: true })
      .eq('company_id', company_id).eq('direcao', 'in'),
    supabase.from('mensagens').select('id', { count: 'exact', head: true })
      .eq('company_id', company_id).eq('direcao', 'out'),
  ])

  // 5) Mensagens dos últimos 90 dias para tempo médio 1ª resposta + SLA
  const { data: msgRows, error: errMsg } = await supabase
    .from('mensagens')
    .select('conversa_id, criado_em, direcao')
    .eq('company_id', company_id)
    .in('direcao', ['in', 'out'])
    .gte('criado_em', desde90d)
    .order('criado_em', { ascending: true })
    .limit(10000)
  if (errMsg) throw errMsg

  const msgsByConv = buildMsgsByConv(msgRows)

  // Tempo médio 1ª resposta + SLA
  let soma = 0, comResposta = 0, dentroSla = 0, comCliente = 0
  for (const msgs of msgsByConv.values()) {
    if (msgs.find((m) => m.direcao === 'in')) comCliente++
    const diff = calcFirstResponseDiff(msgs)
    if (diff == null) continue
    soma += diff
    comResposta++
    if (diff <= slaMin) dentroSla++
  }

  return {
    atendimentosHoje: atendimentosHoje ?? 0,
    conversasHoje,
    totalConversas,
    ticketsAbertos,
    taxaConversao,
    mensagensRecebidas: mensagensRecebidas ?? 0,
    mensagensEnviadas: mensagensEnviadas ?? 0,
    tempoMedioPrimeiraResposta: comResposta > 0 ? Math.round((soma / comResposta) * 10) / 10 : null,
    slaPercentualRespondidas: comResposta > 0 ? Math.round((dentroSla * 100 / comResposta) * 10) / 10 : null,
    slaPercentualTotal: comCliente > 0 ? Math.round((dentroSla * 100 / comCliente) * 10) / 10 : null,
    slaMinutos: slaMin,
  }
}

/**
 * ATENDENTE_MAIS_RAPIDO / ATENDENTE_MAIS_LENTO
 * direction: 'ASC' (rápido) | 'DESC' (lento)
 */
async function qAtendenteSpeed(company_id, direction, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  // Conversas do período com atendente_id
  const { data: convRows, error: errConv } = await supabase
    .from('conversas')
    .select('id, atendente_id')
    .eq('company_id', company_id)
    .gte('criado_em', desde)
    .not('atendente_id', 'is', null)
  if (errConv) throw errConv
  if (!convRows?.length) return null

  const convIds = convRows.map((c) => c.id)
  const atendenteByConv = new Map(convRows.map((c) => [c.id, c.atendente_id]))

  // Mensagens dessas conversas (limite seguro de 10k)
  const { data: msgRows, error: errMsg } = await supabase
    .from('mensagens')
    .select('conversa_id, criado_em, direcao')
    .eq('company_id', company_id)
    .in('conversa_id', convIds)
    .in('direcao', ['in', 'out'])
    .order('criado_em', { ascending: true })
    .limit(10000)
  if (errMsg) throw errMsg

  const msgsByConv = buildMsgsByConv(msgRows)

  // Agrupa diff por atendente
  const byAtendente = new Map()
  for (const [convId, msgs] of msgsByConv.entries()) {
    const atId = atendenteByConv.get(convId)
    if (!atId) continue
    const diff = calcFirstResponseDiff(msgs)
    if (diff == null) continue
    if (!byAtendente.has(atId)) byAtendente.set(atId, { soma: 0, count: 0 })
    const rec = byAtendente.get(atId)
    rec.soma += diff
    rec.count++
  }

  if (!byAtendente.size) return null

  // Busca nomes dos atendentes
  const atendenteIds = Array.from(byAtendente.keys())
  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', atendenteIds)

  const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

  // Calcula média e ordena
  const ranking = Array.from(byAtendente.entries()).map(([atId, rec]) => ({
    id: atId,
    nome: nomeMap.get(atId) || 'Sem nome',
    tempo_medio_min: Math.round((rec.soma / rec.count) * 10) / 10,
    conversas: rec.count,
  }))
  ranking.sort((a, b) => direction === 'ASC'
    ? a.tempo_medio_min - b.tempo_medio_min
    : b.tempo_medio_min - a.tempo_medio_min)

  return ranking[0] || null
}

/** TOP_ATENDENTES_POR_CONVERSAS: ranking por período, top 5. */
async function qTopAtendentesPorConversas(company_id, days, limit = 5) {
  const d = clampDays(days)
  const lim = Math.max(1, Math.min(20, limit))
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  const { data: convRows, error } = await supabase
    .from('conversas')
    .select('atendente_id')
    .eq('company_id', company_id)
    .gte('criado_em', desde)
    .not('atendente_id', 'is', null)
  if (error) throw error
  if (!convRows?.length) return []

  // Conta por atendente em JS
  const countMap = new Map()
  for (const c of convRows) {
    const id = c.atendente_id
    countMap.set(id, (countMap.get(id) || 0) + 1)
  }

  const atendenteIds = Array.from(countMap.keys())
  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', atendenteIds)
  const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

  return Array.from(countMap.entries())
    .map(([id, total]) => ({ id, nome: nomeMap.get(id) || 'Sem nome', total_conversas: total }))
    .sort((a, b) => b.total_conversas - a.total_conversas)
    .slice(0, lim)
}

/** CLIENTES_MAIS_ATIVOS: top 5 clientes com mais mensagens recebidas (direcao='in'). */
async function qClientesMaisAtivos(company_id, days, limit = 5) {
  const d = clampDays(days)
  const lim = Math.max(1, Math.min(20, limit))
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  // Mensagens recebidas do período (limite seguro de 10k)
  const { data: msgRows, error: errMsg } = await supabase
    .from('mensagens')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'in')
    .gte('criado_em', desde)
    .limit(10000)
  if (errMsg) throw errMsg
  if (!msgRows?.length) return []

  // Conta mensagens por conversa_id
  const countByConv = new Map()
  for (const m of msgRows) {
    countByConv.set(m.conversa_id, (countByConv.get(m.conversa_id) || 0) + 1)
  }

  // Pega o cliente_id de cada conversa
  const convIds = Array.from(countByConv.keys())
  const { data: convRows } = await supabase
    .from('conversas')
    .select('id, cliente_id, telefone')
    .eq('company_id', company_id)
    .in('id', convIds)

  const clienteByConv = new Map()
  const telefoneByConv = new Map()
  for (const c of convRows || []) {
    clienteByConv.set(c.id, c.cliente_id)
    telefoneByConv.set(c.id, c.telefone)
  }

  // Agrupa por cliente_id (ou telefone quando cliente_id ausente)
  const countByCliente = new Map() // key: `cl:clienteId` ou `ph:telefone`
  for (const [convId, cnt] of countByConv.entries()) {
    const cliId = clienteByConv.get(convId)
    const key = cliId != null ? `cl:${cliId}` : `ph:${telefoneByConv.get(convId) || convId}`
    if (!countByCliente.has(key)) countByCliente.set(key, { clienteId: cliId, convId, count: 0 })
    countByCliente.get(key).count += cnt
  }

  // Busca nomes dos clientes
  const clienteIds = Array.from(countByCliente.values()).map((r) => r.clienteId).filter(Boolean)
  const { data: clientes } = clienteIds.length
    ? await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', clienteIds)
    : { data: [] }
  const clienteMap = new Map((clientes || []).map((c) => [c.id, c]))

  return Array.from(countByCliente.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, lim)
    .map((r) => {
      const cl = r.clienteId != null ? clienteMap.get(r.clienteId) : null
      const telefone = cl?.telefone || telefoneByConv.get(r.convId) || null
      const nome = cl?.pushname || cl?.nome || telefone || '(sem nome)'
      return { id: r.clienteId, nome, telefone, mensagens: r.count }
    })
}

/** SLA_ALERTAS: conversas abertas/em_atendimento cuja última mensagem é 'in' e excede o SLA. */
async function qSlaAlertas(company_id, limit = 10) {
  const lim = Math.max(1, Math.min(50, limit))

  // SLA config
  const { data: emp } = await supabase
    .from('empresas')
    .select('sla_minutos_sem_resposta')
    .eq('id', company_id)
    .maybeSingle()
  const slaMin = Math.max(1, Math.min(1440, emp?.sla_minutos_sem_resposta ?? 30))

  // Conversas abertas com última mensagem embutida (mesmo padrão do dashboardController)
  const { data: convRows, error } = await supabase
    .from('conversas')
    .select(`
      id, telefone, status_atendimento, atendente_id,
      clientes!conversas_cliente_fk ( nome, pushname ),
      usuarios!conversas_atendente_fk ( nome ),
      mensagens ( direcao, criado_em )
    `)
    .eq('company_id', company_id)
    .in('status_atendimento', ['aberta', 'em_atendimento'])
    .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
    .limit(1, { referencedTable: 'mensagens' })
  if (error) throw error

  const now = Date.now()
  const alertas = []

  for (const c of convRows || []) {
    const lastMsg = Array.isArray(c.mensagens) ? c.mensagens[0] : null
    if (!lastMsg || lastMsg.direcao !== 'in') continue
    const minutos = Math.floor((now - new Date(lastMsg.criado_em).getTime()) / 60000)
    if (minutos < slaMin) continue

    const cl = Array.isArray(c.clientes) ? c.clientes[0] : c.clientes
    const atendente = Array.isArray(c.usuarios) ? c.usuarios[0] : c.usuarios
    alertas.push({
      conversa_id: c.id,
      cliente_nome: cl?.pushname || cl?.nome || c.telefone || '—',
      telefone: c.telefone,
      atendente_nome: atendente?.nome || '—',
      status_atendimento: c.status_atendimento,
      minutos_sem_resposta: minutos,
      limite_sla_min: slaMin,
    })
  }

  alertas.sort((a, b) => b.minutos_sem_resposta - a.minutos_sem_resposta)
  return alertas.slice(0, lim)
}

// ── Função principal exportada ────────────────────────────────────────────────

/**
 * Processa a pergunta do usuário, classifica o intent e executa a query correta.
 *
 * @param {{ company_id: number, question: string, period_days?: number }} opts
 * @returns {{ ok: boolean, intent: string, answer: string, data: any }}
 */
async function answerDashboardQuestion({ company_id, question, period_days }) {
  const cls = await classifyQuestion(question)

  if (cls.intent === 'UNKNOWN') {
    return {
      ok: false,
      intent: 'UNKNOWN',
      answer:
        'Não entendi com segurança. Tente perguntar sobre:\n' +
        '• Resumo das métricas\n' +
        '• Atendente mais rápido/lento\n' +
        '• Top atendentes por conversas\n' +
        '• Clientes mais ativos\n' +
        '• Alertas de SLA',
      data: null,
    }
  }

  const days = clampDays(period_days ?? cls.period_days ?? 7)
  let data = null

  switch (cls.intent) {
    case 'METRICS_OVERVIEW':
      data = await qMetricsOverview(company_id)
      break

    case 'ATENDENTE_MAIS_RAPIDO':
      data = await qAtendenteSpeed(company_id, 'ASC', days)
      break

    case 'ATENDENTE_MAIS_LENTO':
      data = await qAtendenteSpeed(company_id, 'DESC', days)
      break

    case 'TOP_ATENDENTES_POR_CONVERSAS':
      data = await qTopAtendentesPorConversas(company_id, days, 5)
      break

    case 'CLIENTES_MAIS_ATIVOS':
      data = await qClientesMaisAtivos(company_id, days, 5)
      break

    case 'SLA_ALERTAS':
      data = await qSlaAlertas(company_id, 10)
      break

    default:
      data = null
  }

  const answer = await formatAnswer({ intent: cls.intent, data, question })

  return { ok: true, intent: cls.intent, answer, data }
}

module.exports = { answerDashboardQuestion }
