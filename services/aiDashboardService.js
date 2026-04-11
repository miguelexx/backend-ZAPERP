'use strict'

/**
 * aiDashboardService.js
 *
 * Assistente IA do Dashboard ZapERP.
 * - Usa Supabase client (mesmo padrão do restante do projeto).
 * - NÃO permite SQL livre: modelo apenas classifica a pergunta em um intent
 *   permitido; aexecução dos dados é feita por funções pré-definidas aqui.
 * - Todas as queries filtram por company_id (multi-tenant rigoroso).
 *
 * RESTRIÇÃO: Este serviço faz APENAS leitura (SELECT). Nunca atualiza clientes,
 * conversas ou mensagens. Nomes de contatos são atualizados apenas por:
 * Z-API sync, webhook ReceivedCallback, e fallback número quando ausente.
 */

const { z } = require('zod')
const { client: openai } = require('./openaiClient')
const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')

// ── Configuração ──────────────────────────────────────────────────────────────
// Modelo padrão da IA. Pode ser sobrescrito via variável de ambiente AI_MODEL.
// Recomenda-se usar um modelo mais avançado (ex: "gpt-4.1" ou superior) para
// obter respostas mais gerais e inteligentes.
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
    'TEMPO_MEDIO_ATENDENTE', // tempo médio de 1ª resposta de um atendente específico (nome)
    'TOP_ATENDENTES_POR_CONVERSAS',
    'CLIENTES_MAIS_ATIVOS',
    'SLA_ALERTAS',
    // Intents de conversas e mensagens (acesso completo ao histórico)
    'MENSAGENS_USUARIO_CLIENTE',   // mensagens trocadas entre atendente X e cliente Y
    'CONVERSAS_USUARIO_CLIENTE',  // conversas entre atendente X e cliente Y
    'HISTORICO_CLIENTE',           // histórico completo de um cliente
    'HISTORICO_ATENDENTE',        // conversas de um atendente
    'DETALHES_CONVERSA',          // detalhes de uma conversa específica
    'ANALISE_TOM_ATENDENTE',      // tom/educação do atendente (usa amostra de mensagens enviadas)
    // GENERAL_CHAT: perguntas livres
    'GENERAL_CHAT',
    'UNKNOWN',
  ]),
  period_days: z.number().int().min(1).max(365).optional(),
  usuario_nome: z.string().trim().optional(),
  cliente_nome: z.string().trim().optional(),
  cliente_telefone: z.string().trim().optional(),
})

// ── Classificação da pergunta (1ª chamada à OpenAI) ───────────────────────────
async function classifyQuestion(question) {
  const system = `Você é um classificador de perguntas para o Assistente Inteligente do ZapERP (WhatsApp corporativo e CRM).
Retorne SOMENTE JSON válido sem texto extra.
Formato: {"intent": "INTENT", "period_days": N, "usuario_nome": "nome do atendente", "cliente_nome": "nome do cliente", "cliente_telefone": "telefone"}

Para intents de conversas/mensagens, extraia usuario_nome (atendente) e cliente_nome ou cliente_telefone quando mencionados na pergunta.

Intents permitidos:
- METRICS_OVERVIEW: visão geral, resumo, métricas gerais, atendimentos de hoje, tickets abertos, SLA geral
- ATENDENTE_MAIS_RAPIDO: qual atendente tem o MENOR tempo médio de 1ª resposta (ranking geral, sem nome na pergunta)
- ATENDENTE_MAIS_LENTO: qual atendente tem o MAIOR tempo médio de 1ª resposta (ranking geral, sem nome na pergunta)
- TEMPO_MEDIO_ATENDENTE: tempo médio de resposta (ou de 1ª resposta) de UM atendente específico citado pelo nome (ex.: "do João", "da Maria", "funcionário X"); também "quanto tempo X demora para responder"
- TOP_ATENDENTES_POR_CONVERSAS: ranking de atendentes por número de conversas
- CLIENTES_MAIS_ATIVOS: clientes que mais enviaram mensagens (direcao='in')
- SLA_ALERTAS: alertas de SLA, conversas abertas sem resposta dentro do prazo
- MENSAGENS_USUARIO_CLIENTE: quais mensagens foram trocadas, o que conversaram, histórico de mensagens entre atendente X e cliente Y
- CONVERSAS_USUARIO_CLIENTE: conversas entre atendente X e cliente Y, resumo do que foi tratado
- HISTORICO_CLIENTE: histórico/relatório de conversas de um cliente, "como foram as conversas do cliente X"
- HISTORICO_ATENDENTE: conversas de um atendente, com quem o atendente conversou, lista de atendimentos do funcionário X
- DETALHES_CONVERSA: detalhes de uma conversa específica (por id ou por cliente)
- ANALISE_TOM_ATENDENTE: se o atendente é educado, cordial, profissional, tom da comunicação, "trata bem o cliente" (precisa de usuario_nome)
- GENERAL_CHAT: qualquer outra pergunta que possa ser respondida com contexto geral ou conhecimento: melhorar atendimento, dicas, redação, planilhas, ideias, processos, produtividade, e perguntas amplas que não caem em um intent acima. Prefira GENERAL_CHAT a UNKNOWN quando houver dúvida.
- UNKNOWN: apenas se a pergunta estiver vazia, ilegível ou sem nenhuma relação com atendimento/CRM/WhatsApp.

Regra: se "period_days" não for mencionado, use 7.`

  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: 0,
    max_tokens: 150,
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
  const isGeneral = intent === 'GENERAL_CHAT'
  const isTom = intent === 'ANALISE_TOM_ATENDENTE'
  const isConversaIntent = [
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'HISTORICO_ATENDENTE',
    'DETALHES_CONVERSA',
  ].includes(intent)

  const system = isTom
    ? `Você é o Assistente Inteligente do ZapERP. Responda SEMPRE em português do Brasil.

Tarefa: avaliar cordialidade/profissionalismo do atendente com base APENAS na amostra de mensagens enviadas em "Dados" (campo amostra).
Regras:
- Resposta curta: primeiro um veredito direto (sim/não ou "em geral sim, com ressalvas"), depois no máximo 3 bullets com observações objetivas.
- Se amostra vazia ou sem texto, diga que não há mensagens suficientes no período; não invente tom.
- Não julgue o caráter da pessoa; avalie só o texto das mensagens para o contexto de atendimento.
- Não repita frases longas da amostra; cite no máximo trechos muito curtos se necessário.`
    : isConversaIntent
    ? `Você é o Assistente Inteligente do ZapERP. Responda SEMPRE em português do Brasil.

Regras para respostas sobre conversas e mensagens:
- Seja direto: comece pela resposta principal (número, situação ou conclusão) em 1–2 frases.
- Evite introduções longas e repetições. Liste só o que o usuário precisa saber.
- Se houver erro nos dados (ex: "Nenhuma conversa encontrada"), diga isso em uma frase e sugira verificar nome/telefone.
- Ao listar mensagens, ordem cronológica; quem enviou (Atendente/Cliente) de forma compacta.
- Nunca invente dados; use APENAS o campo "Dados".
- Para relatório de conversas de um cliente: resuma status, quantidade de conversas no período e destaques factuais; sem prolixidade.`
    : isGeneral
    ? `Você é o Assistente Inteligente do ZapERP (WhatsApp corporativo e CRM).
Responda SEMPRE em português do Brasil.

Estilo:
- Direto e claro. Sem saudações longas nem encerramentos genéricos ("estou à disposição").
- Responda qualquer pergunta útil ao contexto de atendimento, clientes, equipe, métricas, processos ou redação (mensagens, scripts, planilhas, melhorias).
- Use bullets só quando listar passos ou itens; caso contrário parágrafos curtos.
- Dados do sistema: use somente o que vier em "Dados" (overview, topAtendentes, clientesAtivos, slaAlertas, notasAtendimento). Não invente números.
- Perguntas gerais (como melhorar atendimento, boas práticas): responda com lista enxuta e acionável; sem teoria demais.
- Planilhas: tabela Markdown ou bloco CSV quando pedido.
- Se faltar dado no sistema para um pedido específico, diga em uma frase o que falta e o que ainda dá para concluir com o que há.`
    : `Você é o Assistente Inteligente do ZapERP (métricas). Responda em português do Brasil.
Regras:
- Máximo 2 parágrafos curtos OU até 5 bullets; priorize o número principal na primeira linha.
- Use APENAS números e nomes presentes em "Dados".
- NUNCA invente valores.
- Se "Dados" for null, vazio ou sem informação útil, uma frase dizendo que não há dados no período ou critério.
- Não cite JSON, intent ou termos técnicos.`

  const maxTokens = isConversaIntent ? 1800 : (isGeneral ? 900 : (isTom ? 600 : 400))
  const temp = isConversaIntent ? 0.25 : (isGeneral ? 0.45 : (isTom ? 0.35 : 0.15))
  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: temp,
    max_tokens: maxTokens,
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

/**
 * TEMPO_MEDIO_ATENDENTE: tempo médio de 1ª resposta (min) para um atendente pelo nome.
 */
async function qTempoMedioRespostaAtendente(company_id, usuarioNome, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  let usuario_id = null
  if (usuarioNome) {
    const term = `%${normalizeSearchTerm(usuarioNome)}%`
    const { data: us } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .ilike('nome', term)
      .limit(1)
    usuario_id = us?.[0]?.id ?? null
  }

  if (!usuario_id) {
    return { error: 'Atendente não encontrado. Informe o nome como cadastrado no sistema.', usuario: null, tempo_medio_min: null, conversas_analisadas: 0, periodo_dias: d }
  }

  const usuarioRow = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const { data: convRows, error: errConv } = await supabase
    .from('conversas')
    .select('id')
    .eq('company_id', company_id)
    .eq('atendente_id', usuario_id)
    .gte('criado_em', desde)
  if (errConv) throw errConv
  if (!convRows?.length) {
    return {
      error: null,
      usuario: usuarioRow,
      tempo_medio_min: null,
      conversas_analisadas: 0,
      periodo_dias: d,
      observacao: 'Nenhuma conversa deste atendente no período.',
    }
  }

  const convIds = convRows.map((c) => c.id)
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
  let soma = 0
  let n = 0
  for (const msgs of msgsByConv.values()) {
    const diff = calcFirstResponseDiff(msgs)
    if (diff == null) continue
    soma += diff
    n++
  }

  return {
    error: null,
    usuario: usuarioRow,
    tempo_medio_min: n > 0 ? Math.round((soma / n) * 10) / 10 : null,
    conversas_analisadas: n,
    periodo_dias: d,
  }
}

/**
 * ANALISE_TOM_ATENDENTE: amostra de mensagens enviadas (out) pelo atendente para avaliar tom/cordialidade.
 */
async function qAmostraTextosAtendente(company_id, usuarioNome, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const limitMsgs = 80

  let usuario_id = null
  if (usuarioNome) {
    const term = `%${normalizeSearchTerm(usuarioNome)}%`
    const { data: us } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .ilike('nome', term)
      .limit(1)
    usuario_id = us?.[0]?.id ?? null
  }

  if (!usuario_id) {
    return { error: 'Atendente não encontrado. Informe o nome.', usuario: null, amostra: [], periodo_dias: d }
  }

  const usuario = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const { data: convs } = await supabase
    .from('conversas')
    .select('id')
    .eq('company_id', company_id)
    .eq('atendente_id', usuario_id)
    .gte('criado_em', desde)
    .limit(200)

  const convIds = (convs || []).map((c) => c.id)
  if (!convIds.length) {
    return { error: null, usuario, amostra: [], periodo_dias: d, observacao: 'Nenhuma conversa no período.' }
  }

  const { data: msgs } = await supabase
    .from('mensagens')
    .select('texto, criado_em, conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .in('conversa_id', convIds)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(limitMsgs)

  const amostra = (msgs || [])
    .filter((m) => m.texto && String(m.texto).trim().length > 0)
    .map((m) => ({
      texto: String(m.texto).trim().slice(0, 500),
      criado_em: m.criado_em,
      conversa_id: m.conversa_id,
    }))

  return { error: null, usuario, amostra, periodo_dias: d, total_mensagens: amostra.length }
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
      const nome = getDisplayName(cl) || telefone || '(sem nome)'
      return { id: r.clienteId, nome, telefone, mensagens: r.count }
    })
}

/** NOTAS_ATENDIMENTO: estatísticas de avaliações (nota 0-10) dos clientes após finalização. Inclui media por atendente. */
async function qNotasAtendimentoStats(company_id, days = 30) {
  try {
    const d = clampDays(days)
    const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

    const { data: rows, error } = await supabase
      .from('avaliacoes_atendimento')
      .select('nota, atendente_id')
      .eq('company_id', company_id)
      .gte('criado_em', desde)
    if (error) return null
    if (!rows?.length) return { media: null, total: 0, distribucao: {}, porAtendente: [] }

      let soma = 0
    const distribucao = {}
    for (let i = 0; i <= 10; i++) distribucao[i] = 0
    const byAtendente = new Map()
    for (const r of rows) {
      const n = Number(r.nota)
      if (n >= 0 && n <= 10) {
        soma += n
        distribucao[n] = (distribucao[n] || 0) + 1
        const aid = r.atendente_id
        if (aid) {
          if (!byAtendente.has(aid)) byAtendente.set(aid, { soma: 0, count: 0 })
          const rec = byAtendente.get(aid)
          rec.soma += n
          rec.count++
        }
      }
    }
    const total = rows.length
    const media = total > 0 ? Math.round((soma / total) * 100) / 100 : null

    const atendenteIds = Array.from(byAtendente.keys())
    const { data: usuarios } = atendenteIds.length
      ? await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', atendenteIds)
      : { data: [] }
    const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

    const porAtendente = Array.from(byAtendente.entries()).map(([id, rec]) => ({
      atendente_id: id,
      atendente_nome: nomeMap.get(id) || 'Sem nome',
      media: Math.round((rec.soma / rec.count) * 100) / 100,
      total: rec.count,
    })).sort((a, b) => b.total - a.total)

    return { media, total, distribucao, porAtendente }
  } catch (e) {
    if (String(e?.code || '') === '42P01') {
      console.warn('[aiDashboard] Tabela avaliacoes_atendimento inexistente.')
    }
    return null
  }
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
      cliente_nome: getDisplayName(cl) || c.telefone || '—',
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

/**
 * GENERAL_CHAT: contexto global resumido para o assistente “saber tudo” sobre
 * o que está acontecendo na empresa (dentro de limites seguros).
 * Reaproveita as mesmas funções de métricas já existentes.
 */
async function qGlobalContext(company_id) {
  const [overview, topAtendentes, clientesAtivos, slaAlertas, notasAtendimento] = await Promise.all([
    qMetricsOverview(company_id),
    qTopAtendentesPorConversas(company_id, 30, 5),
    qClientesMaisAtivos(company_id, 30, 5),
    qSlaAlertas(company_id, 20),
    qNotasAtendimentoStats(company_id, 30),
  ])

  return {
    overview,
    topAtendentes,
    clientesAtivos,
    slaAlertas,
    notasAtendimento,
  }
}

/** Normaliza termo para busca (remove acentos, lowercase, trim). */
function normalizeSearchTerm(s) {
  if (!s || typeof s !== 'string') return ''
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** MENSAGENS_USUARIO_CLIENTE: mensagens trocadas entre atendente e cliente (até 200). */
async function qMensagensUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const limitMsgs = 200

  let usuario_id = null
  if (usuarioNome) {
    const term = `%${normalizeSearchTerm(usuarioNome)}%`
    const { data: us } = await supabase
      .from('usuarios')
      .select('id')
      .eq('company_id', company_id)
      .ilike('nome', term)
      .limit(1)
    usuario_id = us?.[0]?.id ?? null
  }

  let cliente_id = null
  let telefoneCliente = null
  if (clienteTelefone) {
    const digits = String(clienteTelefone).replace(/\D/g, '')
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, telefone')
      .eq('company_id', company_id)
      .or(`telefone.eq.${clienteTelefone},telefone.like.%${digits.slice(-8)}`)
      .limit(1)
    if (cl?.[0]) {
      cliente_id = cl[0].id
      telefoneCliente = cl[0].telefone
    }
  }
  if (!cliente_id && clienteNome) {
    const term = `%${normalizeSearchTerm(clienteNome)}%`
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .or(`nome.ilike.${term},pushname.ilike.${term}`)
      .limit(5)
    const first = cl?.[0]
    if (first) {
      cliente_id = first.id
      telefoneCliente = first.telefone
    }
  }

  let qConv = supabase
    .from('conversas')
    .select('id')
    .eq('company_id', company_id)
    .neq('tipo', 'grupo')

  if (usuario_id) qConv = qConv.eq('atendente_id', usuario_id)
  if (cliente_id) qConv = qConv.eq('cliente_id', cliente_id)
  else if (telefoneCliente) qConv = qConv.eq('telefone', telefoneCliente)
  else {
    const { data: convByTel } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .neq('tipo', 'grupo')
    const convIds = (convByTel || []).map((c) => c.id)
    if (convIds.length === 0) return { error: 'Nenhuma conversa encontrada.', mensagens: [], usuario: null, cliente: null }
    qConv = qConv.in('id', convIds)
  }

  const { data: convs } = await qConv.limit(10)
  if (!convs?.length) {
    return {
      error: 'Nenhuma conversa encontrada para os critérios informados. Verifique o nome do atendente e do cliente.',
      mensagens: [],
      usuario: usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null,
      cliente: cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null,
    }
  }

  const convIds = convs.map((c) => c.id)
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('id, texto, direcao, criado_em, autor_usuario_id, remetente_nome')
    .eq('company_id', company_id)
    .in('conversa_id', convIds)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: true })
    .limit(limitMsgs)

  const usuarioMap = new Map()
  const autorIds = [...new Set((msgs || []).map((m) => m.autor_usuario_id).filter(Boolean))]
  if (autorIds.length) {
    const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
    for (const u of us || []) usuarioMap.set(u.id, u.nome)
  }

  const mensagensFormatadas = (msgs || []).map((m) => ({
    texto: m.texto,
    direcao: m.direcao,
    criado_em: m.criado_em,
    remetente: m.direcao === 'out' ? (usuarioMap.get(m.autor_usuario_id) || 'Atendente') : (m.remetente_nome || 'Cliente'),
  }))

  const usuario = usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null
  const cliente = cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null

  return {
    mensagens: mensagensFormatadas,
    total: mensagensFormatadas.length,
    usuario,
    cliente,
    periodo_dias: d,
  }
}

/** CONVERSAS_USUARIO_CLIENTE: resumo das conversas entre atendente e cliente. */
async function qConversasUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days) {
  const result = await qMensagensUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days)
  if (result.error) return result
  return {
    ...result,
    resumo: `Total de ${result.mensagens.length} mensagens no período.`,
  }
}

/** HISTORICO_CLIENTE: conversas e mensagens de um cliente. */
async function qHistoricoCliente(company_id, clienteNome, clienteTelefone, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  let cliente_id = null
  let telefoneCliente = null
  if (clienteTelefone) {
    const digits = String(clienteTelefone).replace(/\D/g, '')
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, telefone')
      .eq('company_id', company_id)
      .or(`telefone.eq.${clienteTelefone},telefone.like.%${digits.slice(-8)}`)
      .limit(1)
    if (cl?.[0]) {
      cliente_id = cl[0].id
      telefoneCliente = cl[0].telefone
    }
  }
  if (!cliente_id && clienteNome) {
    const term = `%${normalizeSearchTerm(clienteNome)}%`
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .or(`nome.ilike.${term},pushname.ilike.${term}`)
      .limit(1)
    if (cl?.[0]) {
      cliente_id = cl[0].id
      telefoneCliente = cl[0].telefone
    }
  }

  if (!cliente_id && !telefoneCliente) {
    return { error: 'Cliente não encontrado. Informe nome ou telefone.', conversas: [], cliente: null }
  }

  let qConv = supabase
    .from('conversas')
    .select('id, criado_em, status_atendimento, atendente_id')
    .eq('company_id', company_id)
    .gte('criado_em', desde)
  if (cliente_id) qConv = qConv.eq('cliente_id', cliente_id)
  else qConv = qConv.eq('telefone', telefoneCliente)

  const { data: convs } = await qConv.order('criado_em', { ascending: false }).limit(50)
  if (!convs?.length) {
    const cliente = cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null
    return { conversas: [], cliente, periodo_dias: d }
  }

  const atendenteIds = [...new Set(convs.map((c) => c.atendente_id).filter(Boolean))]
  const { data: usuarios } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', atendenteIds)
  const atendenteMap = new Map((usuarios || []).map((u) => [u.id, u.nome]))

  const cliente = cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null

  const conversasFormatadas = convs.map((c) => ({
    id: c.id,
    criado_em: c.criado_em,
    status_atendimento: c.status_atendimento,
    atendente_nome: atendenteMap.get(c.atendente_id) || '—',
  }))

  return { conversas: conversasFormatadas, cliente, periodo_dias: d }
}

/** HISTORICO_ATENDENTE: conversas de um atendente. */
async function qHistoricoAtendente(company_id, usuarioNome, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  let usuario_id = null
  if (usuarioNome) {
    const term = `%${normalizeSearchTerm(usuarioNome)}%`
    const { data: us } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .ilike('nome', term)
      .limit(1)
    usuario_id = us?.[0]?.id ?? null
  }

  if (!usuario_id) {
    return { error: 'Atendente não encontrado. Informe o nome.', conversas: [], usuario: null }
  }

  const { data: convs } = await supabase
    .from('conversas')
    .select('id, criado_em, status_atendimento, cliente_id, telefone')
    .eq('company_id', company_id)
    .eq('atendente_id', usuario_id)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(100)

  const clienteIds = [...new Set((convs || []).map((c) => c.cliente_id).filter(Boolean))]
  const { data: clientes } = await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', clienteIds)
  const clienteMap = new Map((clientes || []).map((c) => [c.id, c]))

  const usuario = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const conversasFormatadas = (convs || []).map((c) => ({
    id: c.id,
    criado_em: c.criado_em,
    status_atendimento: c.status_atendimento,
    cliente_nome: c.cliente_id ? (getDisplayName(clienteMap.get(c.cliente_id)) || c.telefone) : c.telefone || '—',
  }))

  return { conversas: conversasFormatadas, usuario, periodo_dias: d }
}

/** DETALHES_CONVERSA: quando não há id, usa GENERAL_CHAT com contexto. */
async function qDetalhesConversa(company_id, clienteNome, clienteTelefone, days) {
  return qHistoricoCliente(company_id, clienteNome, clienteTelefone, days)
}

// ── Função principal exportada ────────────────────────────────────────────────

/**
 * Processa a pergunta do usuário, classifica o intent e executa a query correta.
 *
 * @param {{ company_id: number, question: string, period_days?: number }} opts
 * @returns {{ ok: boolean, intent: string, answer: string, data: any }}
 */
async function answerDashboardQuestion({ company_id, question, period_days }) {
  let cls = await classifyQuestion(question)

  if (cls.intent === 'UNKNOWN') {
    cls = { ...cls, intent: 'GENERAL_CHAT' }
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

    case 'TEMPO_MEDIO_ATENDENTE':
      data = await qTempoMedioRespostaAtendente(company_id, cls.usuario_nome || null, days)
      break

    case 'ANALISE_TOM_ATENDENTE':
      data = await qAmostraTextosAtendente(company_id, cls.usuario_nome || null, days)
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

    case 'GENERAL_CHAT':
      data = await qGlobalContext(company_id)
      break

    case 'MENSAGENS_USUARIO_CLIENTE':
      data = await qMensagensUsuarioCliente(
        company_id,
        cls.usuario_nome || null,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days
      )
      break

    case 'CONVERSAS_USUARIO_CLIENTE':
      data = await qConversasUsuarioCliente(
        company_id,
        cls.usuario_nome || null,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days
      )
      break

    case 'HISTORICO_CLIENTE':
      data = await qHistoricoCliente(
        company_id,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days
      )
      break

    case 'HISTORICO_ATENDENTE':
      data = await qHistoricoAtendente(company_id, cls.usuario_nome || null, days)
      break

    case 'DETALHES_CONVERSA':
      data = await qDetalhesConversa(
        company_id,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days
      )
      break

    default:
      data = null
  }

  const answer = await formatAnswer({ intent: cls.intent, data, question })

  return { ok: true, intent: cls.intent, answer, data }
}

module.exports = { answerDashboardQuestion }
