'use strict'

/**
 * aiDashboardService.js
 *
 * Assistente IA do Dashboard ZapERP.
 * - Usa Supabase client (mesmo padrão do restante do projeto).
 * - NÃO permite SQL livre: modelo apenas classifica a pergunta em um intent
 *   permitido; a execução dos dados é feita por funções pré-definidas aqui.
 * - Intents analíticos: busca em mensagens (WhatsApp), chat interno, clientes por
 *   tema financeiro, conversas por assunto operacional, rankings, avaliações,
 *   desambiguação de nomes, expansão de léxicos e ancoragem por IDs nas evidências.
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
    // Novos intents analíticos (somente leitura + evidências do banco)
    'BUSCA_CONTEUDO_MENSAGENS',           // localizar texto/tema/data em mensagens
    'RANKING_TEMPO_RESPOSTA_ATENDENTES',  // ranking de tempos médios de 1ª resposta
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',  // quem mais enviou mensagens (out) contendo termo/tema
    'QUALIDADE_ATENDIMENTOS_RANKING',     // melhor/pior desempenho por notas de avaliação (quando houver)
    'SINAIS_INTERESSE_COMPRA',            // conversas com termos de intenção de compra/orçamento
    'ATENDIMENTOS_LINGUAGEM_PROBLEMA',    // notas baixas + mensagens com sinais de confusão/insatisfação textual
    'RELATORIO_ATENDENTE_COMPLETO',       // relatório consolidado do atendente (histórico + tempo + amostra)
    'CHAT_INTERNO_POR_TEMA',              // mensagens internal_messages entre funcionários por tema
    'CLIENTES_POR_TEMA_FINANCEIRO',       // clientes que falaram sobre NF, boleto, cobrança, pagamento, pix etc.
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',  // conversas WhatsApp por assunto operacional (suporte, sistema, etc.)
    // GENERAL_CHAT: apenas síntese dos KPIs já carregados (sem conhecimento externo)
    'GENERAL_CHAT',
    'UNKNOWN',
  ]),
  period_days: z.number().int().min(1).max(365).optional(),
  usuario_nome: z.string().trim().optional(),
  cliente_nome: z.string().trim().optional(),
  cliente_telefone: z.string().trim().optional(),
  /** Termos extraídos da pergunta para busca textual (sinônimos separados por vírgula no JSON). */
  termos_busca: z.preprocess((val) => {
    if (val == null || val === '') return undefined
    if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean)
    if (typeof val === 'string') return val.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    return undefined
  }, z.array(z.string()).optional()),
  /** Data única mencionada (YYYY-MM-DD). Ano padrão 2026 se só dia/mês forem citados. */
  data_referencia_iso: z.string().trim().optional(),
})

// ── Léxico e expansão de termos (sem SQL; só listas fixas controladas) ─────────
const LEXICO_PROMOCAO = [
  'promocao', 'promoção', 'desconto', 'oferta', 'cupom', 'black friday', 'liquidacao', 'liquidação',
  'lancamento', 'lançamento', 'preco especial', 'preço especial', 'cashback',
]
const LEXICO_FINANCEIRO = [
  'nota fiscal', 'nota fiscal eletronica', 'nf-e', 'nfe', 'danfe', 'nfs-e', 'nfse',
  'boleto', 'segunda via', 'cobranca', 'cobrança', 'pagamento', 'fatura', 'duplicata',
  'vencimento', 'pix', 'transferencia', 'transferência', 'comprovante', 'inadimplencia', 'inadimplência',
]
const LEXICO_COMERCIAL_COMPRA = [
  'orcamento', 'orçamento', 'proposta comercial', 'proposta', 'fechar pedido', 'fechar negocio', 'fechar negócio',
  'comprar', 'compra', 'pedido', 'contrato', 'assinatura', 'parcelamento', 'parcelas', 'entrada e saldo',
  'valor total', 'forma de pagamento', 'condicao comercial', 'condição comercial', 'venda',
]
const LEXICO_OPERACIONAL = [
  'suporte', 'chamado', 'ticket', 'protocolo', 'erro', 'instabilidade', 'sistema fora', 'nao funciona',
  'não funciona', 'acesso', 'login', 'senha', 'permissao', 'permissão', 'bug', 'lentidao', 'lentidão',
]
const STOPWORDS_EXTRAIR = new Set([
  'como', 'qual', 'quais', 'sobre', 'entre', 'para', 'pelo', 'pela', 'esse', 'essa', 'isso', 'fala', 'falaram',
  'funcionario', 'funcionários', 'cliente', 'atendimento', 'conversa', 'mensagem', 'chat', 'interno', 'interna',
  'me', 'de', 'da', 'do', 'das', 'dos', 'um', 'uma', 'no', 'na', 'nos', 'nas', 'foi', 'ser', 'tem', 'ter',
])

/** Expande termos com variantes sem acento + dedupe + limite para OR no PostgREST. */
function expandTermosForSearch(rawList, max = 22) {
  const out = []
  const seen = new Set()
  for (const raw of rawList || []) {
    const base = sanitizeIlikeTerm(String(raw))
    if (base.length < 2) continue
    const variants = [base]
    const n = normalizeSearchTerm(base)
    if (n && n !== base) variants.push(n)
    for (const v of variants) {
      const k = normalizeSearchTerm(v)
      if (!seen.has(k) && v.length >= 2) {
        seen.add(k)
        out.push(v)
      }
      if (out.length >= max) return out
    }
  }
  return out
}

/** Pós-filtro: remove matches fracos para termos muito curtos (ex.: "nf" só como palavra). */
function textoCasaTermoRobusto(texto, term) {
  if (!texto || !term) return false
  const t = normalizeSearchTerm(String(texto))
  const termNorm = normalizeSearchTerm(String(term).trim())
  if (termNorm.length < 2) return false
  const curtosPalavra = new Set(['nf', 'nfe', 'pix'])
  if (curtosPalavra.has(termNorm)) {
    const re = new RegExp(`(^|[^a-z0-9])${termNorm}([^a-z0-9]|$)`)
    return re.test(t)
  }
  if (termNorm.length <= 3) return t.includes(termNorm)
  return t.includes(termNorm)
}

function evidenciasPassamFiltroRobusto(evidencias, termosUsados) {
  const terms = (termosUsados || []).filter(Boolean)
  if (!terms.length) return evidencias || []
  return (evidencias || []).filter((ev) => {
    const tx = ev.texto_preview || ev.content_preview || ''
    return terms.some((term) => textoCasaTermoRobusto(tx, term))
  })
}

// ── Classificação da pergunta (1ª chamada à OpenAI) ───────────────────────────
async function classifyQuestion(question) {
  const system = `Você é um classificador de perguntas para o Assistente Inteligente do ZapERP (WhatsApp corporativo e CRM).
Retorne SOMENTE JSON válido sem texto extra.
Formato: {"intent": "INTENT", "period_days": N, "usuario_nome": "...", "cliente_nome": "...", "cliente_telefone": "...", "termos_busca": ["termo1","termo2"], "data_referencia_iso": "YYYY-MM-DD"}

Para intents de conversas/mensagens, extraia usuario_nome (atendente) e cliente_nome ou cliente_telefone quando mencionados.

Para BUSCA_CONTEUDO_MENSAGENS e ATENDENTE_MAIS_MENSAGENS_COM_TEMA: preencha termos_busca com palavras-chave curtas em português (sem acento opcional), ex.: ["nota fiscal","nf"], ["promocao","desconto"], ["boleto","cobranca","pagamento"].
Se a pergunta citar uma data sem ano, use o ano corrente em data_referencia_iso.

Intents permitidos:
- METRICS_OVERVIEW: visão geral, resumo, métricas gerais, atendimentos de hoje, tickets abertos, SLA geral
- ATENDENTE_MAIS_RAPIDO: qual atendente tem o MENOR tempo médio de 1ª resposta (ranking geral, sem nome na pergunta)
- ATENDENTE_MAIS_LENTO: qual atendente tem o MAIOR tempo médio de 1ª resposta (ranking geral, sem nome na pergunta)
- RANKING_TEMPO_RESPOSTA_ATENDENTES: lista/ranking de vários atendentes por tempo de 1ª resposta, "quais demoram mais", "ordenar por velocidade"
- TEMPO_MEDIO_ATENDENTE: tempo médio de resposta (ou de 1ª resposta) de UM atendente específico citado pelo nome (ex.: "do João", "da Maria", "funcionário X"); também "quanto tempo X demora para responder"
- TOP_ATENDENTES_POR_CONVERSAS: ranking de atendentes por número de conversas
- CLIENTES_MAIS_ATIVOS: clientes que mais enviaram mensagens (direcao='in')
- SLA_ALERTAS: alertas de SLA, conversas abertas sem resposta dentro do prazo
- MENSAGENS_USUARIO_CLIENTE: quais mensagens foram trocadas, o que conversaram, histórico de mensagens entre atendente X e cliente Y
- CONVERSAS_USUARIO_CLIENTE: conversas entre atendente X e cliente Y, resumo do que foi tratado
- HISTORICO_CLIENTE: histórico/relatório de conversas de um cliente, "como foram as conversas do cliente X"
- HISTORICO_ATENDENTE: só lista de conversas de um atendente (sem pedido de relatório amplo)
- RELATORIO_ATENDENTE_COMPLETO: relatório amplo de desempenho/padrão de atendimento do funcionário X, "como X atende", análise do atendente
- DETALHES_CONVERSA: detalhes de uma conversa específica (por id ou por cliente)
- ANALISE_TOM_ATENDENTE: se o atendente é educado, cordial, profissional, tom da comunicação, "trata bem o cliente" (precisa de usuario_nome)
- BUSCA_CONTEUDO_MENSAGENS: localizar conversa ou trecho que fala sobre algo (nota fiscal, boleto, produto, tema livre), "qual conversa menciona"
- ATENDENTE_MAIS_MENSAGENS_COM_TEMA: qual funcionário mais enviou mensagens sobre um tema (promoção, desconto, campanha) — preencha termos_busca
- QUALIDADE_ATENDIMENTOS_RANKING: melhor/pior qualidade de atendimento por avaliações/notas dos clientes, "quem tem melhor nota"
- SINAIS_INTERESSE_COMPRA: chance de venda, interesse em comprar, orçamento, fechar negócio
- ATENDIMENTOS_LINGUAGEM_PROBLEMA: linguagem ruim, confusa, incompleta, cliente não entendeu, reclamação de comunicação
- CHAT_INTERNO_POR_TEMA: o que funcionários falaram entre si no chat interno (não WhatsApp) sobre um tema — preencha termos_busca
- CLIENTES_POR_TEMA_FINANCEIRO: quais clientes falaram sobre boleto, cobrança, pagamento, nota fiscal, pix, NFE etc. (termos_busca opcional; pode ficar vazio para usar léxico financeiro padrão)
- CONVERSAS_POR_ASSUNTO_OPERACIONAL: conversas de atendimento sobre suporte, sistema, erro, protocolo, operação — preencha termos_busca ou deixe vazio para léxico operacional padrão
- GENERAL_CHAT: pergunta vaga sobre "o sistema" ou situação geral SEM pedido de busca/lista/ranking específico — será respondida APENAS com KPIs agregados já calculados (sem inventar detalhes de conversas).
- UNKNOWN: apenas se a pergunta estiver vazia, ilegível ou sem nenhuma relação com atendimento/CRM/WhatsApp.

Regra: se "period_days" não for mencionado, use 7.`

  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: 0,
    max_tokens: 280,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Ano corrente para datas incompletas: ${new Date().getFullYear()}.\nPergunta: ${question}` },
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
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'ATENDIMENTOS_LINGUAGEM_PROBLEMA',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'RANKING_TEMPO_RESPOSTA_ATENDENTES',
    'QUALIDADE_ATENDIMENTOS_RANKING',
    'RELATORIO_ATENDENTE_COMPLETO',
    'CHAT_INTERNO_POR_TEMA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
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

Regras para respostas sobre conversas, mensagens, buscas e rankings:
- Seja direto: comece pela resposta principal (número, situação ou conclusão) em 1–2 frases.
- Evite introduções longas e repetições. Liste só o que o usuário precisa saber.
- Se houver erro nos dados (ex: "Nenhuma conversa encontrada"), diga isso em uma frase e sugira verificar nome/telefone ou ampliar o período.
- Ao listar mensagens ou evidências, ordem cronológica quando fizer sentido; quem enviou (Atendente/Cliente) de forma compacta.
- Nunca invente dados; use APENAS o campo "Dados". Se "Dados" não contiver a informação pedida, diga explicitamente que o sistema não retornou essa informação no escopo atual.
- Ao citar trechos ou achados, mencione explicitamente os IDs presentes em "Dados": conversa_id, mensagem_id, cliente_id, usuario_id / atendente_id, atendimento_id, avaliacao_id, internal_conversation_id, internal_message_id quando existirem.
- Separe claramente: (1) FATO — só o que está sustentado por números ou textos em "Dados"; (2) INFERÊNCIA LIMITADA — só quando o enunciado disser que é interpretação sobre o subconjunto retornado (nunca como certeza absoluta); (3) LACUNA — o que não consta em "Dados" ou o que o recorte de período/limite de linhas pode ter deixado de fora.
- Não extrapole intenção de venda, humor ou qualidade além do que os textos ou métricas em "Dados" sustentam.
- Se houver campo "avisos" com ambiguidade_usuario ou ambiguidade_cliente, explique que o filtro por pessoa não foi aplicado e liste os candidatos com id.
- Se existir "analitica_ui" em Dados, incorpore no texto: período efetivo em dias, se o período veio do pedido (periodo_definido_na_requisicao) e os alertas (codigo, mensagem, candidatos). Use os rótulos exatos em markdown quando houver conteúdo: **Fatos:** , **Inferência limitada:** , **Lacunas:** , **Alertas e ambiguidade:** — omita seções vazias.
- Para relatório de conversas de um cliente: resuma status, quantidade de conversas no período e destaques factuais; sem prolixidade.`
    : isGeneral
    ? `Você é o Assistente Inteligente do ZapERP (WhatsApp corporativo e CRM).
Responda SEMPRE em português do Brasil.

Regras estritas (somente dados agregados do sistema):
- Use EXCLUSIVAMENTE números e listas presentes em "Dados" (overview, topAtendentes, clientesAtivos, slaAlertas, notasAtendimento).
- NÃO invente métricas, exemplos de conversas, nomes de clientes ou trechos de mensagem que não apareçam em "Dados".
- NÃO ofereça conselhos genéricos, boas práticas de mercado nem "dicas" que não sejam inferência direta dos números mostrados.
- Se a pergunta exigir detalhe de conversa, busca textual ou ranking não incluído em "Dados", responda em uma ou duas frases que isso não está disponível nesta resposta e que o usuário deve reformular (ex.: citar funcionário/cliente ou usar busca por tema).
- Se existir Dados.analitica_ui, mencione período efetivo (dias) e alertas relevantes no bloco **Alertas e ambiguidade:** quando não estiver vazio.
- Estilo: direto, sem saudações longas.`
    : `Você é o Assistente Inteligente do ZapERP (métricas). Responda em português do Brasil.
Regras:
- Máximo 2 parágrafos curtos OU até 5 bullets; priorize o número principal na primeira linha.
- Use APENAS números e nomes presentes em "Dados".
- NUNCA invente valores.
- Se "Dados" for null, vazio ou sem informação útil, uma frase dizendo que não há dados no período ou critério.
- Não cite JSON, intent ou termos técnicos.`

  const maxTokens = isConversaIntent ? 2200 : (isGeneral ? 500 : (isTom ? 600 : 400))
  const temp = isConversaIntent ? 0.2 : (isGeneral ? 0.1 : (isTom ? 0.35 : 0.15))
  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: temp,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Pergunta: ${question}\nIntenção: ${intent}\nDados: ${JSON.stringify(data)}\n\nNota: se Dados.analitica_ui existir, use-o para período, alertas e ambiguidades; não contradiga esses metadados.`,
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
  let ambUsuario = null
  if (usuarioNome) {
    const res = await resolveUsuarioCandidates(company_id, usuarioNome)
    if (res.ambiguous) ambUsuario = res.candidatos
    else usuario_id = res.id
  }

  if (ambUsuario?.length) {
    return {
      error: null,
      ambiguidade_usuario: ambUsuario,
      usuario: null,
      tempo_medio_min: null,
      conversas_analisadas: 0,
      periodo_dias: d,
      observacao: 'Vários usuários correspondem ao nome. Refine com nome completo ou escolha o id na lista em ambiguidade_usuario.',
    }
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
  let ambUsuario = null
  if (usuarioNome) {
    const res = await resolveUsuarioCandidates(company_id, usuarioNome)
    if (res.ambiguous) ambUsuario = res.candidatos
    else usuario_id = res.id
  }

  if (ambUsuario?.length) {
    return {
      error: null,
      ambiguidade_usuario: ambUsuario,
      usuario: null,
      amostra: [],
      periodo_dias: d,
      observacao: 'Vários usuários correspondem ao nome; refine o nome ou use outro critério.',
    }
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
    .select('id, texto, criado_em, conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .in('conversa_id', convIds)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(limitMsgs)

  const amostra = (msgs || [])
    .filter((m) => m.texto && String(m.texto).trim().length > 0)
    .map((m) => ({
      mensagem_id: m.id,
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

/** Remove caracteres que quebram padrões ILIKE no PostgREST e limita tamanho. */
function sanitizeIlikeTerm(s) {
  if (!s || typeof s !== 'string') return ''
  return String(s).trim().slice(0, 64).replace(/[%_\\,]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Limites de dia UTC para data_referencia_iso (YYYY-MM-DD). */
function dayBoundsUtc(isoDate) {
  if (!isoDate || typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null
  const start = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { inicio: start.toISOString(), fim: end.toISOString() }
}

/** Extrai palavras-chave da pergunta quando o classificador não enviou termos (chat interno). */
function extrairTermosCandidatosDaPergunta(question) {
  if (!question || typeof question !== 'string') return []
  const n = normalizeSearchTerm(question).replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const parts = n.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS_EXTRAIR.has(w))
  return [...new Set(parts)].slice(0, 6)
}

function enrichDataReferenciaFromQuestion(cls, question) {
  if (!question || typeof question !== 'string') return cls
  const intentsComData = new Set([
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'CHAT_INTERNO_POR_TEMA',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
  ])
  if (!intentsComData.has(cls.intent) || cls.data_referencia_iso) return cls
  const m = question.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}|\d{2}))?\b/)
  if (!m) return cls
  const dia = Math.min(31, Math.max(1, parseInt(m[1], 10)))
  const mes = Math.min(12, Math.max(1, parseInt(m[2], 10)))
  let ano = new Date().getFullYear()
  if (m[3]) {
    const y = parseInt(m[3], 10)
    ano = m[3].length === 2 ? 2000 + y : y
  }
  const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
  return { ...cls, data_referencia_iso: iso }
}

/** Completa termos_busca com léxico fixo quando o modelo deixou vazio. */
function enrichTermosBuscaFromIntent(cls, question) {
  let termos = cls.termos_busca && cls.termos_busca.length ? [...cls.termos_busca] : []
  const merge = (lex) => {
    termos = [...new Set([...termos, ...lex])]
  }
  if (cls.intent === 'ATENDENTE_MAIS_MENSAGENS_COM_TEMA' && !termos.length) merge(LEXICO_PROMOCAO)
  if (cls.intent === 'CLIENTES_POR_TEMA_FINANCEIRO' && !termos.length) merge(LEXICO_FINANCEIRO)
  if (cls.intent === 'SINAIS_INTERESSE_COMPRA' && !termos.length) merge(LEXICO_COMERCIAL_COMPRA)
  if (cls.intent === 'CONVERSAS_POR_ASSUNTO_OPERACIONAL' && !termos.length) merge(LEXICO_OPERACIONAL)
  if (cls.intent === 'CHAT_INTERNO_POR_TEMA' && !termos.length) {
    const extra = extrairTermosCandidatosDaPergunta(question)
    termos = extra
  }
  return { ...cls, termos_busca: termos.length ? termos : cls.termos_busca }
}

/** Desambiguação de atendentes por nome (máx. 8 candidatos). */
async function resolveUsuarioCandidates(company_id, nome) {
  if (!nome || !String(nome).trim()) return { id: null, candidatos: [], ambiguous: false }
  const term = `%${normalizeSearchTerm(String(nome).trim())}%`
  const { data } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .ilike('nome', term)
    .order('nome', { ascending: true })
    .limit(8)
  const list = data || []
  if (!list.length) return { id: null, candidatos: [], ambiguous: false }
  if (list.length === 1) return { id: list[0].id, candidatos: list, ambiguous: false }
  const target = normalizeSearchTerm(String(nome).trim())
  const exact = list.find((u) => normalizeSearchTerm(u.nome || '') === target)
  if (exact) return { id: exact.id, candidatos: list, ambiguous: false }
  return { id: null, candidatos: list, ambiguous: true }
}

/** Desambiguação de clientes por nome/pushname ou telefone. */
async function resolveClienteCandidates(company_id, clienteNome, clienteTelefone) {
  if (clienteTelefone && String(clienteTelefone).trim()) {
    const digits = String(clienteTelefone).replace(/\D/g, '')
    const { data: cl } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .or(`telefone.eq.${clienteTelefone},telefone.like.%${digits.slice(-8)}`)
      .limit(3)
    if (!cl?.length) return { id: null, candidatos: [], ambiguous: false }
    if (cl.length === 1) return { id: cl[0].id, candidatos: cl, ambiguous: false }
    return { id: null, candidatos: cl, ambiguous: true }
  }
  if (!clienteNome || !String(clienteNome).trim()) return { id: null, candidatos: [], ambiguous: false }
  const term = `%${normalizeSearchTerm(String(clienteNome).trim())}%`
  const { data } = await supabase
    .from('clientes')
    .select('id, nome, pushname, telefone')
    .eq('company_id', company_id)
    .or(`nome.ilike.${term},pushname.ilike.${term}`)
    .order('nome', { ascending: true })
    .limit(8)
  const list = data || []
  if (!list.length) return { id: null, candidatos: [], ambiguous: false }
  if (list.length === 1) return { id: list[0].id, candidatos: list, ambiguous: false }
  const target = normalizeSearchTerm(String(clienteNome).trim())
  const exact = list.find((c) => {
    const n = normalizeSearchTerm(c.nome || '')
    const p = normalizeSearchTerm(c.pushname || '')
    return n === target || p === target
  })
  if (exact) return { id: exact.id, candidatos: list, ambiguous: false }
  return { id: null, candidatos: list, ambiguous: true }
}

/**
 * RANKING_TEMPO_RESPOSTA_ATENDENTES — média de 1ª resposta (min) por atendente, ordenado (mais lento primeiro).
 */
async function qRankingTempoRespostaAtendentes(company_id, days, limit = 15) {
  const d = clampDays(days)
  const lim = Math.max(1, Math.min(30, limit))
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  const { data: convRows, error: errConv } = await supabase
    .from('conversas')
    .select('id, atendente_id')
    .eq('company_id', company_id)
    .gte('criado_em', desde)
    .not('atendente_id', 'is', null)
  if (errConv) throw errConv
  if (!convRows?.length) return { ranking: [], periodo_dias: d, observacao: 'Nenhuma conversa com atendente no período.' }

  const convIds = convRows.map((c) => c.id)
  const atendenteByConv = new Map(convRows.map((c) => [c.id, c.atendente_id]))

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

  if (!byAtendente.size) {
    return { ranking: [], periodo_dias: d, observacao: 'Sem pares cliente→1ª resposta mensuráveis no período.' }
  }

  const atendenteIds = Array.from(byAtendente.keys())
  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', atendenteIds)
  const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

  const ranking = Array.from(byAtendente.entries()).map(([atId, rec]) => ({
    id: atId,
    nome: nomeMap.get(atId) || 'Sem nome',
    tempo_medio_min: Math.round((rec.soma / rec.count) * 10) / 10,
    conversas_medidas: rec.count,
  }))
  ranking.sort((a, b) => b.tempo_medio_min - a.tempo_medio_min)

  return { ranking: ranking.slice(0, lim), periodo_dias: d, total_atendentes: ranking.length }
}

/**
 * BUSCA_CONTEUDO_MENSAGENS — mensagens cujo texto casa com termos expandidos (ILIKE), com contexto e IDs para ancoragem.
 * opts: { usuario_id?, cliente_id?, aplicar_filtro_robusto?: boolean }
 */
async function qBuscaConteudoMensagens(company_id, termos, days, dataIso, opts = {}) {
  const filtros = opts && typeof opts === 'object' ? opts : {}
  const d = clampDays(days)
  const bounds = dayBoundsUtc(dataIso || '')
  const desdePeriodo = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const desde = bounds ? (bounds.inicio > desdePeriodo ? bounds.inicio : desdePeriodo) : desdePeriodo
  const ate = bounds ? bounds.fim : null

  const rawTerms = Array.isArray(termos) ? termos : []
  const terms = expandTermosForSearch(rawTerms, 26)
  if (!terms.length) {
    return { error: 'Nenhum termo de busca válido foi identificado. Reformule com palavras-chave.', evidencias: [], periodo_dias: d }
  }

  let convFilterIds = null
  if (filtros.usuario_id) {
    const { data: c1 } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('atendente_id', filtros.usuario_id)
      .gte('criado_em', desde)
      .neq('tipo', 'grupo')
      .limit(450)
    convFilterIds = (c1 || []).map((c) => c.id)
    if (!convFilterIds.length) {
      return {
        evidencias: [],
        termos_usados: terms,
        periodo_dias: d,
        data_filtro: dataIso || null,
        observacao: 'Nenhuma conversa deste atendente no recorte de tempo usado na busca.',
      }
    }
  }
  if (filtros.cliente_id) {
    const { data: c2 } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('cliente_id', filtros.cliente_id)
      .gte('criado_em', desde)
      .neq('tipo', 'grupo')
      .limit(450)
    const idsCliente = (c2 || []).map((c) => c.id)
    if (!idsCliente.length) {
      return {
        evidencias: [],
        termos_usados: terms,
        periodo_dias: d,
        data_filtro: dataIso || null,
        observacao: 'Nenhuma conversa deste cliente no recorte de tempo usado na busca.',
      }
    }
    convFilterIds = convFilterIds ? convFilterIds.filter((id) => idsCliente.includes(id)) : idsCliente
    if (convFilterIds.length === 0) {
      return {
        evidencias: [],
        termos_usados: terms,
        periodo_dias: d,
        data_filtro: dataIso || null,
        observacao: 'Interseção atendente+cliente não retornou conversas no período.',
      }
    }
  }

  const orClause = terms.map((t) => `texto.ilike.%${t}%`).join(',')
  let q = supabase
    .from('mensagens')
    .select('id, texto, direcao, criado_em, conversa_id, autor_usuario_id, remetente_nome')
    .eq('company_id', company_id)
    .gte('criado_em', desde)
    .or(orClause)
    .order('criado_em', { ascending: false })
    .limit(140)

  if (ate) q = q.lt('criado_em', ate)
  if (convFilterIds?.length) q = q.in('conversa_id', convFilterIds)

  const { data: msgs, error } = await q
  if (error) throw error

  let rows = (msgs || []).filter((m) => m.texto && String(m.texto).trim().length > 0)
  if (filtros.aplicar_filtro_robusto) {
    rows = rows.filter((m) => terms.some((t) => textoCasaTermoRobusto(m.texto, t)))
  }
  if (!rows.length) {
    return { evidencias: [], termos_usados: terms, periodo_dias: d, data_filtro: dataIso || null, observacao: 'Nenhuma mensagem encontrada para os termos no período (e data, se informada).' }
  }

  const convIds = [...new Set(rows.map((m) => m.conversa_id).filter(Boolean))]
  const { data: convs } = await supabase
    .from('conversas')
    .select('id, atendente_id, cliente_id, telefone')
    .eq('company_id', company_id)
    .in('id', convIds)

  const convMap = new Map((convs || []).map((c) => [c.id, c]))
  const atIds = [...new Set((convs || []).map((c) => c.atendente_id).filter(Boolean))]
  const clIds = [...new Set((convs || []).map((c) => c.cliente_id).filter(Boolean))]

  const [{ data: usuarios }, { data: clientes }] = await Promise.all([
    atIds.length
      ? supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', atIds)
      : { data: [] },
    clIds.length
      ? supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', clIds)
      : { data: [] },
  ])
  const usuarioMap = new Map((usuarios || []).map((u) => [u.id, u.nome]))
  const clienteMap = new Map((clientes || []).map((c) => [c.id, c]))

  const autorIds = [...new Set(rows.map((m) => m.autor_usuario_id).filter(Boolean))]
  let autorNomeMap = new Map()
  if (autorIds.length) {
    const { data: autores } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
    autorNomeMap = new Map((autores || []).map((u) => [u.id, u.nome]))
  }

  const evidencias = rows.map((m) => {
    const conv = convMap.get(m.conversa_id) || {}
    const cli = conv.cliente_id ? clienteMap.get(conv.cliente_id) : null
    const nomeCliente = cli ? (getDisplayName(cli) || cli.telefone) : (conv.telefone || '—')
    const nomeAtendente = conv.atendente_id ? (usuarioMap.get(conv.atendente_id) || '—') : '—'
    const quem = m.direcao === 'out'
      ? (autorNomeMap.get(m.autor_usuario_id) || nomeAtendente || 'Atendente')
      : (m.remetente_nome || nomeCliente || 'Cliente')
    return {
      mensagem_id: m.id,
      conversa_id: m.conversa_id,
      cliente_id: conv.cliente_id ?? null,
      usuario_id_autor: m.autor_usuario_id != null ? Number(m.autor_usuario_id) : null,
      atendente_id_conversa: conv.atendente_id != null ? Number(conv.atendente_id) : null,
      criado_em: m.criado_em,
      direcao: m.direcao,
      remetente: quem,
      texto_preview: String(m.texto).trim().slice(0, 400),
    }
  })

  return {
    evidencias,
    termos_usados: terms,
    periodo_dias: d,
    data_filtro: dataIso || null,
    total_retornado: evidencias.length,
    fonte: 'mensagens',
  }
}

/** CHAT_INTERNO_POR_TEMA — busca em internal_messages (isolado do WhatsApp). */
async function qChatInternoPorTema(company_id, termos, days, dataIso) {
  const d = clampDays(days)
  const bounds = dayBoundsUtc(dataIso || '')
  const desdePeriodo = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const desde = bounds ? (bounds.inicio > desdePeriodo ? bounds.inicio : desdePeriodo) : desdePeriodo
  const ate = bounds ? bounds.fim : null
  const terms = expandTermosForSearch(Array.isArray(termos) ? termos : [], 22)
  if (!terms.length) {
    return {
      error: 'Informe um tema ou palavras-chave para buscar no chat interno entre funcionários.',
      evidencias: [],
      fonte: 'internal_messages',
      periodo_dias: d,
    }
  }
  const orClause = terms.map((t) => `content.ilike.%${t}%`).join(',')
  let q = supabase
    .from('internal_messages')
    .select('id, conversation_id, content, created_at, sender_user_id, is_deleted')
    .eq('company_id', company_id)
    .eq('is_deleted', false)
    .gte('created_at', desde)
    .or(orClause)
    .order('created_at', { ascending: false })
    .limit(100)
  if (ate) q = q.lt('created_at', ate)
  const { data: msgs, error } = await q
  if (error) {
    if (String(error.message || '').includes('internal_messages') || String(error.code || '') === '42P01') {
      return { error: 'Chat interno não disponível neste ambiente.', evidencias: [], fonte: 'internal_messages', periodo_dias: d }
    }
    throw error
  }
  const rows = (msgs || []).filter((m) => m.content && String(m.content).trim().length > 0)
  if (!rows.length) {
    return { evidencias: [], termos_usados: terms, periodo_dias: d, data_filtro: dataIso || null, observacao: 'Nenhuma mensagem interna encontrada para os termos.', fonte: 'internal_messages' }
  }
  const convIds = [...new Set(rows.map((m) => m.conversation_id).filter(Boolean))]
  const senderIds = [...new Set(rows.map((m) => m.sender_user_id).filter(Boolean))]
  const [{ data: parts }, { data: nomes }] = await Promise.all([
    convIds.length
      ? supabase.from('internal_conversation_participants').select('conversation_id, user_id').eq('company_id', company_id).in('conversation_id', convIds)
      : { data: [] },
    senderIds.length
      ? supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', senderIds)
      : { data: [] },
  ])
  const nomeMap = new Map((nomes || []).map((u) => [u.id, u.nome || 'Sem nome']))
  const partByConv = new Map()
  for (const p of parts || []) {
    if (!partByConv.has(p.conversation_id)) partByConv.set(p.conversation_id, [])
    partByConv.get(p.conversation_id).push(p.user_id)
  }
  const evidencias = rows.map((m) => {
    const peers = (partByConv.get(m.conversation_id) || []).filter((uid) => uid !== m.sender_user_id)
    return {
      internal_message_id: m.id,
      internal_conversation_id: m.conversation_id,
      usuario_id_remetente: m.sender_user_id,
      remetente: nomeMap.get(m.sender_user_id) || '—',
      participantes_conversa_ids: partByConv.get(m.conversation_id) || [],
      parceiros_potenciais_ids: peers,
      criado_em: m.created_at,
      texto_preview: String(m.content).trim().slice(0, 400),
    }
  })
  return { evidencias, termos_usados: terms, periodo_dias: d, data_filtro: dataIso || null, total_retornado: evidencias.length, fonte: 'internal_messages' }
}

/** CLIENTES_POR_TEMA_FINANCEIRO — agrega clientes que enviaram/receberam conversas com menções ao léxico financeiro. */
async function qClientesPorTemaFinanceiro(company_id, days, dataIso) {
  const terms = expandTermosForSearch(LEXICO_FINANCEIRO, 26)
  const busca = await qBuscaConteudoMensagens(company_id, terms, days, dataIso, { aplicar_filtro_robusto: true })
  const ev = busca.evidencias || []
  const byCliente = new Map()
  for (const e of ev) {
    const cid = e.cliente_id
    if (!cid) continue
    if (!byCliente.has(cid)) byCliente.set(cid, { cliente_id: cid, ocorrencias: 0, conversas: new Set(), exemplo_mensagem_id: null, exemplo_conversa_id: null })
    const r = byCliente.get(cid)
    r.ocorrencias++
    if (e.conversa_id) r.conversas.add(e.conversa_id)
    if (!r.exemplo_mensagem_id && e.mensagem_id) {
      r.exemplo_mensagem_id = e.mensagem_id
      r.exemplo_conversa_id = e.conversa_id
    }
  }
  const ids = [...byCliente.keys()]
  const { data: clientes } = ids.length
    ? await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', ids)
    : { data: [] }
  const cmap = new Map((clientes || []).map((c) => [c.id, c]))
  const ranking = [...byCliente.values()]
    .map((r) => {
      const cl = cmap.get(r.cliente_id)
      return {
        cliente_id: r.cliente_id,
        nome: cl ? (getDisplayName(cl) || cl.telefone) : String(r.cliente_id),
        telefone: cl?.telefone || null,
        mensagens_com_tema: r.ocorrencias,
        conversas_distintas: r.conversas.size,
        exemplo_mensagem_id: r.exemplo_mensagem_id,
        exemplo_conversa_id: r.exemplo_conversa_id,
      }
    })
    .sort((a, b) => b.mensagens_com_tema - a.mensagens_com_tema)
    .slice(0, 25)
  return {
    clientes: ranking,
    termos_usados: terms,
    periodo_dias: busca.periodo_dias,
    data_filtro: dataIso || null,
    observacao: 'Lista baseada em mensagens de texto que casam com o léxico financeiro; mídia sem transcrição não entra.',
    total_evidencias_analisadas: ev.length,
  }
}

/** CONVERSAS_POR_ASSUNTO_OPERACIONAL — agrupa conversas com ocorrências do léxico operacional + termos da pergunta. */
async function qConversasPorAssuntoOperacional(company_id, termos, days, dataIso) {
  const merged = [...new Set([...(termos || []), ...LEXICO_OPERACIONAL])]
  const terms = expandTermosForSearch(merged, 26)
  const busca = await qBuscaConteudoMensagens(company_id, terms, days, dataIso, {})
  const map = new Map()
  for (const e of busca.evidencias || []) {
    if (!e.conversa_id) continue
    if (!map.has(e.conversa_id)) {
      map.set(e.conversa_id, {
        conversa_id: e.conversa_id,
        cliente_id: e.cliente_id,
        ocorrencias: 0,
        ultima_em: e.criado_em,
        exemplo_mensagem_id: e.mensagem_id,
      })
    }
    const r = map.get(e.conversa_id)
    r.ocorrencias++
    if (new Date(e.criado_em).getTime() > new Date(r.ultima_em).getTime()) {
      r.ultima_em = e.criado_em
      r.exemplo_mensagem_id = e.mensagem_id
    }
  }
  const conversas = [...map.values()].sort((a, b) => b.ocorrencias - a.ocorrencias).slice(0, 40)
  const clIds = [...new Set(conversas.map((c) => c.cliente_id).filter(Boolean))]
  const { data: cls } = clIds.length
    ? await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', clIds)
    : { data: [] }
  const cm = new Map((cls || []).map((c) => [c.id, c]))
  for (const c of conversas) {
    const cl = c.cliente_id ? cm.get(c.cliente_id) : null
    c.cliente_nome = cl ? (getDisplayName(cl) || cl.telefone) : null
  }
  return {
    conversas,
    termos_usados: terms,
    periodo_dias: busca.periodo_dias,
    data_filtro: dataIso || null,
    observacao: 'Agrupamento por conversa com base em texto de mensagens; não infere assunto além dos termos casados.',
  }
}

/**
 * ATENDENTE_MAIS_MENSAGENS_COM_TEMA — conta mensagens enviadas (out) por autor_usuario_id contendo o primeiro termo forte.
 */
async function qAtendentesMaisMensagensComTema(company_id, termos, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const terms = expandTermosForSearch(termos || [], 24)
  if (!terms.length) {
    return { error: 'Informe um tema na pergunta (ex.: promoção, desconto).', ranking: [], periodo_dias: d }
  }
  const primary = terms[0]
  const orClause = terms.map((t) => `texto.ilike.%${t}%`).join(',')

  const { data: msgs, error } = await supabase
    .from('mensagens')
    .select('id, autor_usuario_id, texto')
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .gte('criado_em', desde)
    .or(orClause)
    .limit(2500)

  if (error) throw error

  const withAutor = (msgs || []).filter((m) => {
    if (!m.autor_usuario_id || !m.texto) return false
    return terms.some((t) => textoCasaTermoRobusto(m.texto, t))
  })
  if (!withAutor.length) {
    return { ranking: [], termos_usados: terms, periodo_dias: d, observacao: 'Nenhuma mensagem de atendente encontrada com esses termos.' }
  }

  const countMap = new Map()
  for (const m of withAutor) {
    const id = m.autor_usuario_id
    countMap.set(id, (countMap.get(id) || 0) + 1)
  }

  const ids = Array.from(countMap.keys())
  const { data: usuarios } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', ids)
  const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

  const ranking = Array.from(countMap.entries())
    .map(([uid, n]) => ({ usuario_id: uid, nome: nomeMap.get(uid) || 'Sem nome', mensagens_com_tema: n }))
    .sort((a, b) => b.mensagens_com_tema - a.mensagens_com_tema)

  return {
    ranking: ranking.slice(0, 15),
    termos_usados: terms,
    termo_principal: primary,
    periodo_dias: d,
    total_mensagens_classificadas: withAutor.length,
  }
}

/** QUALIDADE_ATENDIMENTOS_RANKING — ordena por média de notas (avaliações) quando existir histórico. */
async function qQualidadeAtendimentosRanking(company_id, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const stats = await qNotasAtendimentoStats(company_id, days)
  if (!stats || !stats.total) {
    return {
      melhor: [],
      pior: [],
      observacao: 'Não há avaliações de atendimento registradas no período. Não é possível rankear qualidade por nota.',
      periodo_dias: d,
    }
  }
  let samples = []
  try {
    const { data } = await supabase
      .from('avaliacoes_atendimento')
      .select('id, nota, atendente_id, conversa_id, atendimento_id, cliente_id, criado_em')
      .eq('company_id', company_id)
      .gte('criado_em', desde)
      .order('criado_em', { ascending: false })
      .limit(400)
    samples = data || []
  } catch (_) {
    samples = []
  }
  const exemploPorAtendente = new Map()
  for (const s of samples) {
    if (!s.atendente_id || exemploPorAtendente.has(s.atendente_id)) continue
    exemploPorAtendente.set(s.atendente_id, {
      exemplo_avaliacao_id: s.id,
      exemplo_conversa_id: s.conversa_id,
      exemplo_atendimento_id: s.atendimento_id,
      exemplo_cliente_id: s.cliente_id,
    })
  }
  const enrich = (arr) => arr.map((row) => ({
    ...row,
    ...(exemploPorAtendente.get(row.atendente_id) || {}),
  }))
  const sorted = [...(stats.porAtendente || [])].sort((a, b) => b.media - a.media)
  const melhor = enrich(sorted.slice(0, 10))
  const pior = enrich([...sorted].reverse().slice(0, 10))
  return {
    media_geral: stats.media,
    total_avaliacoes: stats.total,
    melhor,
    pior,
    periodo_dias: d,
    observacao: 'Fato: ranking por média de notas numéricas (avaliacoes_atendimento). Inferência limitada: não mede automaticamente qualidade linguística das mensagens.',
  }
}

/** SINAIS_INTERESSE_COMPRA — busca textual com léxico de intenção comercial. */
async function qSinaisInteresseCompra(company_id, days) {
  const termosLexico = expandTermosForSearch(LEXICO_COMERCIAL_COMPRA, 26)
  return qBuscaConteudoMensagens(company_id, termosLexico, days, null, {})
}

/** ATENDIMENTOS_LINGUAGEM_PROBLEMA — combina notas baixas e mensagens com padrões de insatisfação/confusão. */
async function qAtendimentosLinguagemProblema(company_id, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  let avaliacoesBaixas = []
  try {
    const { data: avRows } = await supabase
      .from('avaliacoes_atendimento')
      .select('id, nota, conversa_id, atendente_id, criado_em, cliente_id, atendimento_id')
      .eq('company_id', company_id)
      .lte('nota', 4)
      .gte('criado_em', desde)
      .order('criado_em', { ascending: false })
      .limit(40)
    const aids = [...new Set((avRows || []).map((r) => r.atendente_id).filter(Boolean))]
    const { data: us } = aids.length
      ? await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', aids)
      : { data: [] }
    const nm = new Map((us || []).map((u) => [u.id, u.nome]))
    avaliacoesBaixas = (avRows || []).map((r) => ({
      avaliacao_id: r.id,
      atendimento_id: r.atendimento_id,
      nota: r.nota,
      conversa_id: r.conversa_id,
      cliente_id: r.cliente_id,
      atendente_id: r.atendente_id,
      atendente_nome: nm.get(r.atendente_id) || '—',
      criado_em: r.criado_em,
    }))
  } catch (_) {
    avaliacoesBaixas = []
  }

  const padroes = [
    'nao entendi', 'não entendi', 'confuso', 'confusa', 'absurdo',
    'pessimo', 'péssimo', 'horrivel', 'horrível', 'mal explicado', 'incompleto',
  ]
  const padroesExp = expandTermosForSearch(padroes, 24)
  const busca = await qBuscaConteudoMensagens(company_id, padroesExp, days, null, {})

  return {
    periodo_dias: d,
    avaliacoes_baixas: avaliacoesBaixas,
    mensagens_insatisfacao_ou_confusao: busca.evidencias || [],
    observacao: 'Heurística: notas ≤4 (fato) + mensagens com termos de confusão/reclamação (fato por casamento de texto). Inferência limitada: não diagnostica “falha de comunicação” além desses sinais. Ausência de achados não prova bom desempenho.',
  }
}

/** RELATORIO_ATENDENTE_COMPLETO — agrega histórico, tempo médio e amostra de textos sem alterar as funções base. */
async function qRelatorioAtendenteCompleto(company_id, usuarioNome, days) {
  const historico = await qHistoricoAtendente(company_id, usuarioNome, days)
  if (historico.ambiguidade_usuario?.length) {
    return {
      historico_conversas: historico,
      tempo_primeira_resposta: null,
      amostra_mensagens_enviadas: null,
      periodo_dias: clampDays(days),
      observacao: 'Relatório interrompido: resolva a ambiguidade de nome do atendente antes de consolidar métricas.',
    }
  }
  const [tempo, tom] = await Promise.all([
    qTempoMedioRespostaAtendente(company_id, usuarioNome, days),
    qAmostraTextosAtendente(company_id, usuarioNome, days),
  ])
  return { historico_conversas: historico, tempo_primeira_resposta: tempo, amostra_mensagens_enviadas: tom, periodo_dias: clampDays(days) }
}

/** MENSAGENS_USUARIO_CLIENTE: mensagens trocadas entre atendente e cliente (até 200). */
async function qMensagensUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const limitMsgs = 200

  let usuario_id = null
  let ambUsuario = null
  if (usuarioNome) {
    const res = await resolveUsuarioCandidates(company_id, usuarioNome)
    if (res.ambiguous) ambUsuario = res.candidatos
    else usuario_id = res.id
  }
  if (ambUsuario?.length) {
    return {
      error: null,
      ambiguidade_usuario: ambUsuario,
      mensagens: [],
      usuario: null,
      cliente: null,
      periodo_dias: d,
      observacao: 'Há mais de um usuário com nome parecido; use nome completo cadastrado ou refine a pergunta.',
    }
  }

  let cliente_id = null
  let telefoneCliente = null
  let ambCliente = null
  const cr = await resolveClienteCandidates(company_id, clienteNome || null, clienteTelefone || null)
  if (cr.ambiguous) ambCliente = cr.candidatos
  else {
    cliente_id = cr.id
    if (cr.candidatos?.[0]?.telefone) telefoneCliente = cr.candidatos[0].telefone
  }
  if (ambCliente?.length && (clienteNome || clienteTelefone)) {
    return {
      error: null,
      ambiguidade_cliente: ambCliente,
      mensagens: [],
      usuario: usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null,
      cliente: null,
      periodo_dias: d,
      observacao: 'Há mais de um cliente correspondente; informe telefone ou nome mais completo.',
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
    mensagem_id: m.id,
    conversa_id: m.conversa_id,
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
    const cr = await resolveClienteCandidates(company_id, clienteNome, null)
    if (cr.ambiguous) {
      return { error: null, ambiguidade_cliente: cr.candidatos, conversas: [], cliente: null, periodo_dias: d, observacao: 'Vários clientes correspondem ao nome; use telefone ou nome completo.' }
    }
    if (cr.id) {
      cliente_id = cr.id
      telefoneCliente = cr.candidatos?.[0]?.telefone || null
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
    atendente_id: c.atendente_id ?? null,
    criado_em: c.criado_em,
    status_atendimento: c.status_atendimento,
    atendente_nome: atendenteMap.get(c.atendente_id) || '—',
  }))

  return { conversas: conversasFormatadas, cliente, cliente_id: cliente?.id ?? null, periodo_dias: d }
}

/** HISTORICO_ATENDENTE: conversas de um atendente. */
async function qHistoricoAtendente(company_id, usuarioNome, days) {
  const d = clampDays(days)
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  let usuario_id = null
  let ambUsuario = null
  if (usuarioNome) {
    const res = await resolveUsuarioCandidates(company_id, usuarioNome)
    if (res.ambiguous) ambUsuario = res.candidatos
    else usuario_id = res.id
  }

  if (ambUsuario?.length) {
    return {
      error: null,
      ambiguidade_usuario: ambUsuario,
      conversas: [],
      usuario: null,
      periodo_dias: d,
      observacao: 'Vários usuários correspondem ao nome; informe nome completo ou telefone do cliente para desambiguar o contexto.',
    }
  }

  if (!usuario_id) {
    return { error: 'Atendente não encontrado. Informe o nome.', conversas: [], usuario: null }
  }

  const { data: convs } = await supabase
    .from('conversas')
    .select('id, criado_em, status_atendimento, cliente_id, telefone, atendente_id')
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
    atendente_id: c.atendente_id ?? null,
    cliente_id: c.cliente_id ?? null,
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

/** Metadados opcionais para o frontend (contrato estável: chave aditiva em data). */
function inferFonteDados(intent) {
  if (intent === 'CHAT_INTERNO_POR_TEMA') return 'internal_messages'
  if ([
    'BUSCA_CONTEUDO_MENSAGENS',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'SINAIS_INTERESSE_COMPRA',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'ATENDIMENTOS_LINGUAGEM_PROBLEMA',
  ].includes(intent)) return 'mensagens_whatsapp'
  return null
}

function pushAmbUsuario(alertas, lista, origem) {
  if (!Array.isArray(lista) || !lista.length) return
  alertas.push({
    codigo: 'AMBIGUIDADE_USUARIO',
    severidade: 'aviso',
    titulo: 'Funcionário ambíguo',
    mensagem: 'Mais de um usuário corresponde ao nome; refine o nome completo ou use outro critério.',
    origem: origem || 'consulta',
    candidatos: lista.map((u) => ({ usuario_id: u.id, nome: u.nome })),
  })
}

function pushAmbCliente(alertas, lista, origem) {
  if (!Array.isArray(lista) || !lista.length) return
  alertas.push({
    codigo: 'AMBIGUIDADE_CLIENTE',
    severidade: 'aviso',
    titulo: 'Cliente ambíguo',
    mensagem: 'Mais de um cliente corresponde ao nome; informe telefone ou nome mais completo.',
    origem: origem || 'consulta',
    candidatos: lista.map((c) => ({
      cliente_id: c.id,
      nome: c.nome || c.pushname || null,
      telefone: c.telefone || null,
    })),
  })
}

function attachAnaliticaUiMeta(data, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const { intent, days, periodoDefinidoNoBody } = ctx
  const alertas = []
  pushAmbUsuario(alertas, data.ambiguidade_usuario, 'raiz')
  pushAmbCliente(alertas, data.ambiguidade_cliente, 'raiz')
  const h = data.historico_conversas
  if (h && typeof h === 'object') {
    pushAmbUsuario(alertas, h.ambiguidade_usuario, 'historico_conversas')
    pushAmbCliente(alertas, h.ambiguidade_cliente, 'historico_conversas')
  }
  for (const k of ['tempo_primeira_resposta', 'amostra_mensagens_enviadas']) {
    const sub = data[k]
    if (sub && typeof sub === 'object') pushAmbUsuario(alertas, sub.ambiguidade_usuario, k)
  }
  if (Array.isArray(data.avisos)) {
    for (const av of data.avisos) {
      const tipo = av.tipo || 'aviso'
      if (tipo === 'ambiguidade_usuario' && Array.isArray(av.candidatos)) {
        pushAmbUsuario(alertas, av.candidatos, 'busca_filtro')
      } else if (tipo === 'ambiguidade_cliente' && Array.isArray(av.candidatos)) {
        pushAmbCliente(alertas, av.candidatos, 'busca_filtro')
      } else {
        alertas.push({
          codigo: 'AVISO_GENERICO',
          severidade: 'info',
          titulo: String(tipo),
          mensagem: 'Ver detalhes em candidatos se houver.',
          candidatos: av.candidatos || null,
        })
      }
    }
  }
  if (data.error && typeof data.error === 'string') {
    alertas.push({
      codigo: 'SEM_RESULTADO_OU_ERRO',
      severidade: 'info',
      titulo: 'Mensagem do sistema',
      mensagem: data.error,
    })
  }
  const analitica_ui = {
    intent,
    periodo_dias_efetivo: days,
    periodo_definido_na_requisicao: periodoDefinidoNoBody === true,
    periodo_padrao_usado: periodoDefinidoNoBody !== true,
    fonte_dados: data.fonte || inferFonteDados(intent),
    alertas,
  }
  return { ...data, analitica_ui }
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
  cls = enrichDataReferenciaFromQuestion(cls, question)
  cls = enrichTermosBuscaFromIntent(cls, question)

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

    case 'RANKING_TEMPO_RESPOSTA_ATENDENTES':
      data = await qRankingTempoRespostaAtendentes(company_id, days, 15)
      break

    case 'BUSCA_CONTEUDO_MENSAGENS': {
      const optsBusca = {}
      const avisosBusca = []
      if (cls.usuario_nome) {
        const ur = await resolveUsuarioCandidates(company_id, cls.usuario_nome)
        if (ur.ambiguous) avisosBusca.push({ tipo: 'ambiguidade_usuario', candidatos: ur.candidatos })
        else if (ur.id) optsBusca.usuario_id = ur.id
      }
      if (cls.cliente_nome || cls.cliente_telefone) {
        const cr = await resolveClienteCandidates(company_id, cls.cliente_nome || null, cls.cliente_telefone || null)
        if (cr.ambiguous) avisosBusca.push({ tipo: 'ambiguidade_cliente', candidatos: cr.candidatos })
        else if (cr.id) optsBusca.cliente_id = cr.id
      }
      const termosExp = expandTermosForSearch(cls.termos_busca || [], 26)
      const listaTermos = termosExp.length ? termosExp : (cls.termos_busca || [])
      data = await qBuscaConteudoMensagens(
        company_id,
        listaTermos,
        days,
        cls.data_referencia_iso || null,
        optsBusca
      )
      if (avisosBusca.length) data = { ...data, avisos: avisosBusca }
      break
    }

    case 'CHAT_INTERNO_POR_TEMA':
      data = await qChatInternoPorTema(company_id, cls.termos_busca || [], days, cls.data_referencia_iso || null)
      break

    case 'CLIENTES_POR_TEMA_FINANCEIRO':
      data = await qClientesPorTemaFinanceiro(company_id, days, cls.data_referencia_iso || null)
      break

    case 'CONVERSAS_POR_ASSUNTO_OPERACIONAL':
      data = await qConversasPorAssuntoOperacional(
        company_id,
        cls.termos_busca || [],
        days,
        cls.data_referencia_iso || null
      )
      break

    case 'ATENDENTE_MAIS_MENSAGENS_COM_TEMA':
      data = await qAtendentesMaisMensagensComTema(company_id, cls.termos_busca || [], days)
      break

    case 'QUALIDADE_ATENDIMENTOS_RANKING':
      data = await qQualidadeAtendimentosRanking(company_id, days)
      break

    case 'SINAIS_INTERESSE_COMPRA':
      data = await qSinaisInteresseCompra(company_id, days)
      break

    case 'ATENDIMENTOS_LINGUAGEM_PROBLEMA':
      data = await qAtendimentosLinguagemProblema(company_id, days)
      break

    case 'RELATORIO_ATENDENTE_COMPLETO':
      data = await qRelatorioAtendenteCompleto(company_id, cls.usuario_nome || null, days)
      break

    default:
      data = null
  }

  const periodoDefinidoNoBody = period_days != null && Number.isFinite(Number(period_days))
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data = attachAnaliticaUiMeta(data, {
      intent: cls.intent,
      days,
      periodoDefinidoNoBody,
    })
  }

  const answer = await formatAnswer({ intent: cls.intent, data, question })

  return { ok: true, intent: cls.intent, answer, data }
}

module.exports = { answerDashboardQuestion }
