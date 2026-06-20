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

function chunkArray(arr, size) {
  const a = arr || []
  const out = []
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size))
  return out
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
    'RANKING_EDUCACAO_ATENDENTES',        // ranking objetivo de cordialidade por sinais textuais
    'QUALIDADE_ATENDIMENTOS_RANKING',     // melhor/pior desempenho por notas de avaliação (quando houver)
    'SINAIS_INTERESSE_COMPRA',            // conversas com termos de intenção de compra/orçamento
    'ATENDIMENTOS_LINGUAGEM_PROBLEMA',    // notas baixas + mensagens com sinais de confusão/insatisfação textual
    'RELATORIO_ATENDENTE_COMPLETO',       // relatório consolidado do atendente (histórico + tempo + amostra)
    'CHAT_INTERNO_POR_TEMA',              // mensagens internal_messages entre funcionários por tema
    'CLIENTES_POR_TEMA_FINANCEIRO',       // clientes que falaram sobre NF, boleto, cobrança, pagamento, pix etc.
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',  // conversas WhatsApp por assunto operacional (suporte, sistema, etc.)
    'ATENDIMENTOS_TRANSFERIDOS', // linhas em atendimentos com transferência no período
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE', // cliente enviou (in) no período e o atendente não enviou (out) como autor no período
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR', // mensagens out com autor_usuario_id = atendente no período
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
  'produto', 'produtos', 'catalogo', 'catálogo', 'venda', 'vendas',
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

const LEXICO_CORDIAL_POSITIVO = [
  'bom dia', 'boa tarde', 'boa noite', 'por favor', 'obrigado', 'obrigada', 'agradeco', 'agradeço',
  'fico a disposicao', 'fico à disposição', 'gentileza', 'poderia', 'por gentileza', 'combinado',
]
const LEXICO_CORDIAL_NEGATIVO = [
  'nao posso ajudar', 'não posso ajudar', 'problema seu', 'se vira', 'tanto faz', 'ja expliquei', 'já expliquei',
  'nao vou', 'não vou', 'nao quero', 'não quero', 'inaceitavel', 'inaceitável',
]

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
- HISTORICO_ATENDENTE: conversas e clientes de um atendente no período, "com quem X falou", "quais clientes", listas operacionais (use quando NÃO for só transferência, só "sem resposta" ou só listagem explícita de mensagens enviadas por autor)
- ATENDIMENTOS_TRANSFERIDOS: transferências entre atendentes registradas (transferiu), "quem transferiu para quem", "atendimentos transferidos hoje"
- CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE: cliente mandou mensagem no período e o atendente citado não enviou resposta (como autor) no mesmo período na conversa sob responsabilidade dele
- MENSAGENS_ENVIADAS_ATENDENTE_AUTOR: listar mensagens que o atendente realmente enviou (autor_usuario_id), "o que Larissa enviou", "mensagens que Wagner mandou hoje"
- RELATORIO_ATENDENTE_COMPLETO: relatório amplo de desempenho/padrão de atendimento do funcionário X, "como X atende", análise do atendente
- DETALHES_CONVERSA: detalhes de uma conversa específica (por id ou por cliente)
- ANALISE_TOM_ATENDENTE: se o atendente é educado, cordial, profissional, tom da comunicação, "trata bem o cliente" (precisa de usuario_nome)
- BUSCA_CONTEUDO_MENSAGENS: localizar conversa ou trecho que fala sobre algo (nota fiscal, boleto, produto, tema livre), "qual conversa menciona"
- ATENDENTE_MAIS_MENSAGENS_COM_TEMA: qual funcionário mais enviou mensagens sobre um tema (promoção, desconto, campanha) — preencha termos_busca
- RANKING_EDUCACAO_ATENDENTES: quando a pergunta pedir "qual atendente é o mais educado", "quem é mais cordial", "ranking de educação/cordialidade entre atendentes"
- QUALIDADE_ATENDIMENTOS_RANKING: melhor/pior qualidade de atendimento por avaliações/notas dos clientes, "quem tem melhor nota"
- SINAIS_INTERESSE_COMPRA: chance de venda, interesse em comprar, orçamento, fechar negócio
- ATENDIMENTOS_LINGUAGEM_PROBLEMA: linguagem ruim, confusa, incompleta, cliente não entendeu, reclamação de comunicação
- CHAT_INTERNO_POR_TEMA: o que funcionários falaram entre si no chat interno (não WhatsApp) sobre um tema — preencha termos_busca
- CLIENTES_POR_TEMA_FINANCEIRO: quais clientes falaram sobre boleto, cobrança, pagamento, nota fiscal, pix, NFE etc. (termos_busca opcional; pode ficar vazio para usar léxico financeiro padrão)
- CONVERSAS_POR_ASSUNTO_OPERACIONAL: conversas de atendimento sobre suporte, sistema, erro, protocolo, operação — preencha termos_busca ou deixe vazio para léxico operacional padrão
- GENERAL_CHAT: pergunta vaga sobre "o sistema" ou situação geral SEM pedido de busca/lista/ranking específico — será respondida APENAS com KPIs agregados já calculados (sem inventar detalhes de conversas).
- UNKNOWN: apenas se a pergunta estiver vazia, ilegível ou sem nenhuma relação com atendimento/CRM/WhatsApp.

Regras de período:
- Se "period_days" não for mencionado, use 7.
- Se a pergunta deixar claro um dia civil específico (ex.: "hoje", "ontem", "nesta semana", "neste mês", "dia 14/04"), use period_days=1 quando for só um dia, ou um número coerente com a semana/mês pedido; o backend ainda refina o recorte — sua prioridade é classificar intent e entidades corretamente.`

  const resp = await openai.chat.completions.create({
    model: AI_MODEL(),
    temperature: 0,
    max_tokens: 320,
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

/** overview aninhado (GENERAL_CHAT) ou métricas na raiz (METRICS_OVERVIEW). */
function overviewLikePayload(data) {
  if (!data || typeof data !== 'object') return null
  if (data.overview && typeof data.overview === 'object') return data.overview
  if (data.totalConversas != null || data.ticketsAbertos != null || data.atendimentosHoje != null) return data
  return null
}

/**
 * Evita resposta textual negando atividade quando o payload tem totais > 0.
 */
function sanearRespostaContradicaoMetricas(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  if (intent !== 'GENERAL_CHAT' && intent !== 'METRICS_OVERVIEW') return answer
  const ov = overviewLikePayload(data)
  if (!ov || typeof ov !== 'object') return answer
  const tc = Number(ov.totalConversas)
  const mr = Number(ov.mensagensRecebidas)
  const me = Number(ov.mensagensEnviadas)
  const ta = Number(ov.ticketsAbertos)
  const ch = Number(ov.conversasHoje)
  const cf = Number(ov.conversasFechadas)
  const tem = (tc > 0) || (mr > 0) || (me > 0) || (ta > 0) || (ch > 0) || (cf > 0)
  if (!tem) return answer
  const pat = /(n(ao|ão)\s+h(ouve|á|existem)|sem\s+(conversas?|atendimentos?|registros?)|n(enhum|uma)\s+conversa|zero\s+(conversas?|atividade)|nada\s+(registrad|consta)|não\s+houve\s+(atendimentos?|conversas?)|não\s+há\s+(conversas?|atendimentos?|registros?)|não\s+consta|não\s+existem\s+conversas?|inexistente)/i
  if (!pat.test(answer)) return answer
  const ah = ov.atendimentosHoje ?? 0
  return `${answer.trim()}\n\n**Correção automática (dados do painel):** Há totais positivos no escopo retornado: totalConversas (amostra): ${tc}, conversasHoje: ${ch}, conversasFechadas: ${cf}, ticketsAbertos: ${ta}, mensagens recebidas/enviadas (totais na tabela mensagens): ${mr} / ${me}. O valor atendimentosHoje (${ah}) refere-se só a eventos na tabela atendimentos desde hoje, não substitui conversas nem mensagens.`
}

function evidenciaConversasOuMensagens(data, intent) {
  const nm = Array.isArray(data?.mensagens) ? data.mensagens.length : 0
  if (nm > 0) return { tipo: 'mensagens', n: nm, label: 'mensagens' }
  const nc = Array.isArray(data?.conversas) ? data.conversas.length : 0
  if (nc > 0) return { tipo: 'conversas', n: nc, label: 'conversas' }
  if (intent === 'ATENDIMENTOS_TRANSFERIDOS') {
    const nt = Array.isArray(data?.transferencias) ? data.transferencias.length : 0
    if (nt > 0) return { tipo: 'transferencias', n: nt, label: 'transferencias' }
  }
  if (intent === 'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE') {
    const ns = Array.isArray(data?.clientes_sem_resposta) ? data.clientes_sem_resposta.length : 0
    if (ns > 0) return { tipo: 'clientes_sem_resposta', n: ns, label: 'clientes_sem_resposta' }
  }
  if (intent === 'RELATORIO_ATENDENTE_COMPLETO') {
    const h = data?.historico_conversas
    const nhc = Array.isArray(h?.conversas) ? h.conversas.length : 0
    if (nhc > 0) return { tipo: 'historico_conversas', n: nhc, label: 'historico_conversas.conversas' }
  }
  return null
}

/** Evita negar interação quando o payload já traz mensagens ou conversas. */
function sanearNegacaoComEvidenciaMensagens(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const intents = new Set([
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'HISTORICO_ATENDENTE',
    'DETALHES_CONVERSA',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
  ])
  if (!intents.has(intent)) return answer
  const ev = evidenciaConversasOuMensagens(data, intent)
  if (!ev) return answer
  const pat = /(n(ao|ão)\s+(encontr|há)|sem\s+(conversa|mensagens|transfer(ê|e)ncia)|nenhuma\s+(conversa|mensagem|transfer(ê|e)ncia)|não\s+houve\s+(conversa|mensagem)|não\s+existe\s+conversa|não\s+encontramos)/i
  if (!pat.test(answer)) return answer
  const onde =
    ev.tipo === 'mensagens'
      ? 'Dados.mensagens'
      : ev.tipo === 'transferencias'
        ? 'Dados.transferencias'
        : `Dados.${ev.label}`
  const idHint =
    ev.tipo === 'transferencias'
      ? 'atendimento_id / conversa_id'
      : ev.tipo === 'clientes_sem_resposta'
        ? 'conversa_id / cliente_id'
        : 'conversa_id / mensagem_id'
  return `${answer.trim()}\n\n**Correção automática:** O retorno inclui ${ev.n} registro(s) em ${onde}; o texto não pode negar esse fato. Cite ${idHint} ao resumir.`
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
    'RANKING_EDUCACAO_ATENDENTES',
    'RANKING_TEMPO_RESPOSTA_ATENDENTES',
    'QUALIDADE_ATENDIMENTOS_RANKING',
    'RELATORIO_ATENDENTE_COMPLETO',
    'CHAT_INTERNO_POR_TEMA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
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
- Se Dados.mensagens for um array com itens, houve interação retornada pelo sistema: resuma o conteúdo; NUNCA diga que não houve conversa ou mensagens entre as partes para esse recorte.
- CRÍTICO — tempo e datas: se existir Dados.recorte_temporal, siga à risca Dados.recorte_temporal.instrucao_temporal_obrigatoria. Só use "hoje", "ontem" ou "nesta conversa de hoje" se Dados.recorte_temporal.pode_usar_hoje_no_texto for true; caso contrário use "nas mensagens retornadas", "no período analisado" ou cite Dados.recorte_temporal.primeiro_data_exibicao / ultimo_data_exibicao. Nunca confunda a janela de consulta (Dados.periodo_dias) com o dia civil das mensagens. O mesmo vale para buscas com Dados.evidencias quando houver recorte_temporal.
- Resumo inteligente: se existir Dados.orientacao_resumo_ia e flags em mensagens, priorize flags.peso_resumo alto; trate flags.provavel_automatica como mensagem de roteiro/sistema (mencione de leve, não como foco principal); destaque conteúdo útil do cliente e do atendente; para mídias use tipo, nome_arquivo e url quando existirem; não repita várias linhas quase idênticas (use Dados.mensagens_compactas como apoio narrativo se ajudar).
- Se houver erro nos dados (ex: "Nenhuma conversa encontrada"), diga isso em uma frase e sugira verificar nome/telefone ou ampliar o período.
- Ao listar mensagens ou evidências, ordem cronológica quando fizer sentido; quem enviou (Atendente/Cliente) de forma compacta.
- Nunca invente dados; use APENAS o campo "Dados". Se "Dados" não contiver a informação pedida, diga explicitamente que o sistema não retornou essa informação no escopo atual.
- Ao citar trechos ou achados, mencione explicitamente os IDs presentes em "Dados": conversa_id, mensagem_id, cliente_id, usuario_id / atendente_id, atendimento_id, avaliacao_id, internal_conversation_id, internal_message_id quando existirem.
- Separe com clareza (texto fluido, não robótico): **Fatos:** (datas, IDs, quem disse o quê com base nas mensagens); **Inferência limitada:** (interpretação cautelosa); **Lacunas:** (o que faltou no recorte); **Alertas e ambiguidade:** — omita seções vazias.
- Não extrapole intenção de venda, humor ou qualidade além do que os textos ou métricas em "Dados" sustentam.
- Se houver campo "avisos" com ambiguidade_usuario ou ambiguidade_cliente, explique que o filtro por pessoa não foi aplicado e liste os candidatos com id.
- Se existir "analitica_ui" em Dados, incorpore no texto: período efetivo em dias, se o período veio do pedido (periodo_definido_na_requisicao), recorte_mensagens (datas reais) e os alertas (codigo, mensagem, candidatos). Não contradiga analitica_ui.recorte_mensagens.
- CRÍTICO — resumo_operacional_ia: se existir Dados.resumo_operacional_ia, use obrigatoriamente os totais total_clientes_unicos, total_conversas e total_mensagens desse bloco para afirmações quantitativas. Não confunda cliente com conversa nem conversa com mensagem. Siga Dados.resumo_operacional_ia.instrucao_obrigatoria_sobre_contagens. Liste todos os nomes em clientes_detalhes quando a pergunta pedir "todos" ou lista completa. Dados.resumo_operacional_ia.distincao_entidades explica o significado de cada nível.
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
- CRÍTICO — consistência numérica: leia overview.legenda_metricas se existir. O campo atendimentosHoje NÃO é "quantidade de conversas" nem "volume de mensagens"; é contagem de linhas na tabela atendimentos desde hoje. Se totalConversas, conversasHoje, conversasFechadas, ticketsAbertos ou mensagensRecebidas/mensagensEnviadas forem > 0, NUNCA diga que "não houve conversas", "não há atendimentos registrados" ou "zero atividade" no sentido global do CRM — descreva os números que são > 0 e explique a diferença dos campos.
- Nunca contradiga o JSON: se um total for positivo, o texto deve reconhecer esse fato.
- Estilo: direto, sem saudações longas.`
    : `Você é o Assistente Inteligente do ZapERP (métricas). Responda em português do Brasil.
Regras:
- Máximo 2 parágrafos curtos OU até 5 bullets; priorize o número principal na primeira linha.
- Use APENAS números e nomes presentes em "Dados".
- NUNCA invente valores.
- Se "Dados" for null, vazio ou sem informação útil, uma frase dizendo que não há dados no período ou critério.
- Se Dados trouxer atendimentosHoje e também totalConversas, conversasFechadas, ticketsAbertos ou mensagensRecebidas/mensagensEnviadas: não confunda — atendimentosHoje conta só linhas na tabela atendimentos desde hoje; não negue conversas/mensagens se esses totais forem > 0. Leia legenda_metricas se existir.
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
        content: `Pergunta: ${question}\nIntenção: ${intent}\nDados: ${JSON.stringify(data)}\n\nNotas: (1) Se Dados.analitica_ui existir, use-o para período, alertas e ambiguidades; não contradiga. (2) Se Dados.recorte_temporal existir, a linguagem sobre "hoje"/datas deve obedecer a recorte_temporal.instrucao_temporal_obrigatoria. (3) Se Dados.resumo_operacional_ia existir, não contradiga seus totais nem omita clientes/conversas listados ali quando o usuário pedir lista completa.`,
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

async function fetchMensagensPaged(buildQuery, { pageSize = 2000, maxRows = 30000 } = {}) {
  const rows = []
  let from = 0
  while (from < maxRows) {
    const to = Math.min(from + pageSize - 1, maxRows - 1)
    const { data, error } = await buildQuery(from, to)
    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }
  return rows
}

function contarOcorrenciasNoTexto(texto, lexico) {
  const t = normalizeSearchTerm(String(texto || ''))
  if (!t) return 0
  let n = 0
  for (const termo of lexico) {
    if (textoCasaTermoRobusto(t, termo)) n++
  }
  return n
}

function notaCordialidadePorMensagem(texto) {
  const positivos = contarOcorrenciasNoTexto(texto, LEXICO_CORDIAL_POSITIVO)
  const negativos = contarOcorrenciasNoTexto(texto, LEXICO_CORDIAL_NEGATIVO)
  return { positivos, negativos }
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
    if (
      c.status_atendimento === 'aberta' ||
      c.status_atendimento === 'em_atendimento' ||
      c.status_atendimento === 'aguardando_cliente'
    ) ticketsAbertos++
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
    conversasFechadas,
    taxaConversao,
    mensagensRecebidas: mensagensRecebidas ?? 0,
    mensagensEnviadas: mensagensEnviadas ?? 0,
    tempoMedioPrimeiraResposta: comResposta > 0 ? Math.round((soma / comResposta) * 10) / 10 : null,
    slaPercentualRespondidas: comResposta > 0 ? Math.round((dentroSla * 100 / comResposta) * 10) / 10 : null,
    slaPercentualTotal: comCliente > 0 ? Math.round((dentroSla * 100 / comCliente) * 10) / 10 : null,
    slaMinutos: slaMin,
    /** Evita confusão LLM: atendimentosHoje ≠ conversas; totais de mensagens são globais. */
    legenda_metricas: {
      atendimentosHoje: 'Eventos na tabela atendimentos com criado_em desde hoje (assumiu/transferiu/encerrou/reabriu). Zero não significa ausência de conversas.',
      totalConversas: 'Quantidade de conversas na amostra analisada (até 5000 mais recentes).',
      conversasHoje: 'Conversas com criado_em hoje dentro dessa amostra.',
      ticketsAbertos: 'Conversas com status_atendimento "aberta" ou "em_atendimento" na mesma amostra.',
      conversasFechadas: 'Conversas com status_atendimento "fechada" na mesma amostra.',
      mensagensRecebidas: 'Total na tabela mensagens (direcao=in), sem filtro de data.',
      mensagensEnviadas: 'Total na tabela mensagens (direcao=out), sem filtro de data.',
    },
    amostra_conversas_max: 5000,
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
async function qTempoMedioRespostaAtendente(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true

  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

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

  let convRows = []
  if (fixadoPergunta && fxIn && fxEx) {
    const { data: mHit } = await supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', company_id)
      .gte('criado_em', fxIn)
      .lt('criado_em', fxEx)
      .limit(4000)
    const cand = [...new Set((mHit || []).map((r) => r.conversa_id).filter(Boolean))]
    if (cand.length) {
      const { data: convF } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .eq('atendente_id', usuario_id)
        .in('id', cand.slice(0, 500))
      convRows = convF || []
    }
  } else {
    const { data: c0, error: errConv } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('atendente_id', usuario_id)
      .gte('criado_em', desde)
    if (errConv) throw errConv
    convRows = c0 || []
  }
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
  let qMsgT = supabase
    .from('mensagens')
    .select('conversa_id, criado_em, direcao')
    .eq('company_id', company_id)
    .in('conversa_id', convIds)
    .in('direcao', ['in', 'out'])
    .gte('criado_em', desde)
    .order('criado_em', { ascending: true })
    .limit(10000)
  if (ateExclusive) qMsgT = qMsgT.lt('criado_em', ateExclusive)
  const { data: msgRows, error: errMsg } = await qMsgT
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

  const outT = {
    error: null,
    usuario: usuarioRow,
    tempo_medio_min: n > 0 ? Math.round((soma / n) * 10) / 10 : null,
    conversas_analisadas: n,
    periodo_dias: d,
  }
  if (fxIn && fxEx) {
    outT.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal_mensagens: 'mensagens.criado_em',
    }
  }
  return outT
}

/**
 * ANALISE_TOM_ATENDENTE: amostra de mensagens enviadas (out) pelo atendente para avaliar tom/cordialidade.
 */
async function qAmostraTextosAtendente(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true

  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }
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

  let convIds = []
  if (fixadoPergunta && fxIn && fxEx) {
    const { data: mrows } = await supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', company_id)
      .eq('autor_usuario_id', usuario_id)
      .eq('direcao', 'out')
      .gte('criado_em', fxIn)
      .lt('criado_em', fxEx)
      .limit(500)
    convIds = [...new Set((mrows || []).map((r) => r.conversa_id).filter(Boolean))].slice(0, 200)
  } else {
    const { data: convs } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('atendente_id', usuario_id)
      .gte('criado_em', desde)
      .limit(200)
    convIds = (convs || []).map((c) => c.id)
  }
  if (!convIds.length) {
    return { error: null, usuario, amostra: [], periodo_dias: d, observacao: 'Nenhuma conversa no período.' }
  }

  let qAm = supabase
    .from('mensagens')
    .select('id, texto, criado_em, conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .in('conversa_id', convIds)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(limitMsgs)
  if (ateExclusive) qAm = qAm.lt('criado_em', ateExclusive)
  const { data: msgs } = await qAm

  let amostra = (msgs || [])
    .filter((m) => m.texto && String(m.texto).trim().length > 0)
    .map((m) => ({
      mensagem_id: m.id,
      texto: String(m.texto).trim().slice(0, 500),
      criado_em: m.criado_em,
      conversa_id: m.conversa_id,
    }))
  amostra = filtrarPorCriadoEm(amostra, desde, ateExclusive, 'criado_em')

  const outAm = { error: null, usuario, amostra, periodo_dias: d, total_mensagens: amostra.length }
  if (fxIn && fxEx) {
    outAm.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal_mensagens: 'mensagens.criado_em',
    }
    outAm.recorte_temporal = buildRecorteTemporalMeta(amostra.map((m) => ({ criado_em: m.criado_em })), {
      periodo_dias: d,
      periodo_explicito: true,
      periodo_pedido_inicio_iso: fxIn,
      periodo_pedido_fim_exclusive_iso: fxEx,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    }) || buildRecorteTemporalMeta([], {
      periodo_dias: d,
      periodo_explicito: true,
      periodo_pedido_inicio_iso: fxIn,
      periodo_pedido_fim_exclusive_iso: fxEx,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    })
  }
  return outAm
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

/** CLIENTES_MAIS_ATIVOS: ranking de clientes com mais mensagens recebidas (direcao='in'). */
async function qClientesMaisAtivos(company_id, days, limit = 5) {
  const d = clampDays(days)
  const lim = Math.max(1, Math.min(20, limit))
  const desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

  // Mensagens recebidas do período (paginação para evitar corte em alto volume).
  const msgRows = await fetchMensagensPaged((from, to) => (
    supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', company_id)
      .eq('direcao', 'in')
      .gte('criado_em', desde)
      .range(from, to)
  ), { pageSize: 2500, maxRows: 50000 })
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

/** Exclui conversas de grupo (tipo ou JID @g.us); mantém tipo NULL (legado). */
function filtrarConversasIndividuais(rows) {
  return (rows || []).filter((c) => {
    const t = String(c.tipo || '').toLowerCase()
    if (t === 'grupo' || t === 'group') return false
    if (String(c.telefone || '').includes('@g.us')) return false
    return true
  })
}

const RECORTE_TZ = 'America/Sao_Paulo'

function calendarKeyInTz(iso, tz = RECORTE_TZ) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function formatDateTimeBR(iso, tz = RECORTE_TZ) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })
}

function calendarKeyToBRLabel(yyyyMmDd) {
  if (!yyyyMmDd || !/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return yyyyMmDd
  const [y, m, d] = yyyyMmDd.split('-')
  return `${d}/${m}/${y}`
}

/** Início do dia civil (yyyy-mm-dd) em `tz`, como instante UTC (ms). America/Sao_Paulo sem DST desde 2019. */
function startOfZonedDayUtcMs(tz, y, m, d) {
  const pad = (n) => String(n).padStart(2, '0')
  const target = `${y}-${pad(m)}-${pad(d)}`
  let anchor = null
  for (let h = -14; h <= 38; h++) {
    const ms = Date.UTC(y, m - 1, d, h, 0, 0)
    const key = calendarKeyInTz(new Date(ms).toISOString(), tz)
    if (key === target) {
      anchor = ms
      break
    }
  }
  if (anchor == null) return Date.UTC(y, m - 1, d, 3, 0, 0)
  let s = anchor
  while (s > 0 && calendarKeyInTz(new Date(s - 1000).toISOString(), tz) === target) s -= 1000
  return s
}

function startIsoFromCalendarKey(tz, key) {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  return new Date(startOfZonedDayUtcMs(tz, y, m, d)).toISOString()
}

function addDaysToCalendarKey(key, delta) {
  const [y, mo, da] = key.split('-').map(Number)
  const ms0 = startOfZonedDayUtcMs(RECORTE_TZ, y, mo, da)
  const ms1 = ms0 + Number(delta) * 86400000
  return calendarKeyInTz(new Date(ms1).toISOString(), RECORTE_TZ)
}

function endExclusiveIsoFromCalendarKey(tz, key) {
  const next = addDaysToCalendarKey(key, 1)
  return startIsoFromCalendarKey(tz, next)
}

/** Limites [inicio, fim) para um dia civil em America/Sao_Paulo a partir de YYYY-MM-DD. */
function dayBoundsSpForIsoDate(yyyyMmDd) {
  if (!yyyyMmDd || typeof yyyyMmDd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return null
  return {
    inicio: startIsoFromCalendarKey(RECORTE_TZ, yyyyMmDd),
    fim: endExclusiveIsoFromCalendarKey(RECORTE_TZ, yyyyMmDd),
  }
}

function calendarKeyNowSp() {
  return calendarKeyInTz(new Date().toISOString(), RECORTE_TZ)
}

function calendarKeyWeekMondaySp() {
  let k = calendarKeyNowSp()
  for (let i = 0; i < 8; i++) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: RECORTE_TZ, weekday: 'short' }).format(new Date(startIsoFromCalendarKey(RECORTE_TZ, k)))
    if (wd === 'Mon') return k
    k = addDaysToCalendarKey(k, -1)
  }
  return k
}

function calendarKeyMonthFirstFromKey(k) {
  const [y, m] = k.split('-')
  return `${y}-${m}-01`
}

function calendarKeyNextMonthFirstFromKey(k) {
  const [y, m] = k.split('-').map(Number)
  const nm = m >= 12 ? 1 : m + 1
  const ny = m >= 12 ? y + 1 : y
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

function parseDmyFromMatch(g1, g2, g3, defaultYear) {
  const dia = Math.min(31, Math.max(1, parseInt(g1, 10)))
  const mes = Math.min(12, Math.max(1, parseInt(g2, 10)))
  let ano = defaultYear
  if (g3) {
    const y = parseInt(g3, 10)
    ano = String(g3).length === 2 ? 2000 + y : y
  }
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/**
 * Interpretação determinística de período na pergunta (fuso America/Sao_Paulo).
 * Sobrepõe janelas padrão (7/90 dias) quando o administrador pede dia/semana/mês explícitos.
 */
function resolveTemporalAnalyticsScope(question, cls) {
  const qRaw = String(question || '').trim()
  if (!qRaw) return null
  const q = qRaw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const anoRef = new Date().getFullYear()

  const range = qRaw.match(/\bentre\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+e\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/i)
    || qRaw.match(/\bde\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+ate\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/i)
  if (range) {
    const k0 = parseDmyFromMatch(range[1], range[2], range[3], anoRef)
    const k1 = parseDmyFromMatch(range[4], range[5], range[6] || range[3], anoRef)
    const [first, last] = k0 <= k1 ? [k0, k1] : [k1, k0]
    const fimEx = endExclusiveIsoFromCalendarKey(RECORTE_TZ, last)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, first)
    if (inicio && fimEx) {
      return {
        fixado_na_pergunta: true,
        rotulo: `De ${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(last)} (${RECORTE_TZ})`,
        opts: {
          periodo_mensagens_inicio_iso: inicio,
          periodo_mensagens_fim_exclusive_iso: fimEx,
          periodo_consulta_rotulo: `De ${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(last)}`,
          impedir_fallback_mensagens_antigas: true,
          periodo_fixado_na_pergunta: true,
        },
      }
    }
  }

  if (/\bhoje\b/.test(q) || /\bagora\b/.test(q) || /\bneste dia\b/.test(q)) {
    const k = calendarKeyNowSp()
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, k)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, k)
    return {
      fixado_na_pergunta: true,
      rotulo: `Hoje (${calendarKeyToBRLabel(k)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: `Hoje (${calendarKeyToBRLabel(k)})`,
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\bontem\b/.test(q)) {
    const k = addDaysToCalendarKey(calendarKeyNowSp(), -1)
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, k)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, k)
    return {
      fixado_na_pergunta: true,
      rotulo: `Ontem (${calendarKeyToBRLabel(k)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: `Ontem (${calendarKeyToBRLabel(k)})`,
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\besta semana\b/.test(q) || /\bnesta semana\b/.test(q)) {
    const mon = calendarKeyWeekMondaySp()
    const today = calendarKeyNowSp()
    const fim = endExclusiveIsoFromCalendarKey(RECORTE_TZ, today)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, mon)
    return {
      fixado_na_pergunta: true,
      rotulo: `Semana corrente (${calendarKeyToBRLabel(mon)} a ${calendarKeyToBRLabel(today)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: 'Esta semana (segunda a hoje)',
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  if (/\beste mes\b/.test(q) || /\bneste mes\b/.test(q)) {
    const today = calendarKeyNowSp()
    const first = calendarKeyMonthFirstFromKey(today)
    const next = calendarKeyNextMonthFirstFromKey(first)
    const inicio = startIsoFromCalendarKey(RECORTE_TZ, first)
    const fim = startIsoFromCalendarKey(RECORTE_TZ, next)
    return {
      fixado_na_pergunta: true,
      rotulo: `Mês corrente (${calendarKeyToBRLabel(first)} a ${calendarKeyToBRLabel(today)}, ${RECORTE_TZ})`,
      opts: {
        periodo_mensagens_inicio_iso: inicio,
        periodo_mensagens_fim_exclusive_iso: fim,
        periodo_consulta_rotulo: 'Este mês',
        impedir_fallback_mensagens_antigas: true,
        periodo_fixado_na_pergunta: true,
      },
    }
  }

  const INTENTS_DIA_UNICO = new Set([
    'BUSCA_CONTEUDO_MENSAGENS',
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'DETALHES_CONVERSA',
    'HISTORICO_ATENDENTE',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
  ])
  if (cls?.data_referencia_iso && INTENTS_DIA_UNICO.has(cls.intent)) {
    const b = dayBoundsSpForIsoDate(cls.data_referencia_iso)
    if (b?.inicio && b?.fim) {
      return {
        fixado_na_pergunta: true,
        rotulo: `Dia ${calendarKeyToBRLabel(cls.data_referencia_iso)} (${RECORTE_TZ})`,
        opts: {
          periodo_mensagens_inicio_iso: b.inicio,
          periodo_mensagens_fim_exclusive_iso: b.fim,
          periodo_consulta_rotulo: `Dia ${calendarKeyToBRLabel(cls.data_referencia_iso)}`,
          impedir_fallback_mensagens_antigas: true,
          periodo_fixado_na_pergunta: true,
        },
      }
    }
  }

  return null
}

function filtrarPorCriadoEm(list, inicioIso, fimExclusiveIso, campo = 'criado_em') {
  if (!inicioIso || !Array.isArray(list)) return list || []
  return list.filter((row) => {
    const ts = row?.[campo]
    if (!ts) return false
    if (ts < inicioIso) return false
    if (fimExclusiveIso && ts >= fimExclusiveIso) return false
    return true
  })
}

/** Metadados das datas reais das mensagens — evita "hoje" indevido no texto gerado. */
function buildRecorteTemporalMeta(mensagens, ctx) {
  const list = (mensagens || []).filter((m) => m && m.criado_em)
  if (!list.length) {
    const pi = ctx?.periodo_pedido_inicio_iso
    const pf = ctx?.periodo_pedido_fim_exclusive_iso
    if (pi && pf) {
      const minK = calendarKeyInTz(pi)
      const maxK = calendarKeyInTz(new Date(Date.parse(pf) - 1).toISOString())
      const todayKey = calendarKeyNowSp()
      const pode = minK === maxK && minK === todayKey
      const rot = ctx?.rotulo_pedido || `${calendarKeyToBRLabel(minK)} a ${calendarKeyToBRLabel(maxK)}`
      return {
        fuso: RECORTE_TZ,
        primeiro_criado_em: pi,
        ultimo_criado_em: new Date(Date.parse(pf) - 1).toISOString(),
        primeiro_data_exibicao: formatDateTimeBR(pi),
        ultimo_data_exibicao: formatDateTimeBR(new Date(Date.parse(pf) - 1).toISOString()),
        primeiro_dia_calendario: minK,
        ultimo_dia_calendario: maxK,
        dias_distintos_calendario: minK === maxK ? 1 : 2,
        pode_usar_hoje_no_texto: pode,
        janela_consulta_dias: ctx?.periodo_dias ?? null,
        periodo_definido_na_requisicao: ctx?.periodo_explicito === true,
        sem_mensagens_no_periodo: true,
        instrucao_temporal_obrigatoria: `Nenhuma mensagem foi retornada para o período solicitado (${rot}, ${RECORTE_TZ}). Não invente diálogo nem use "hoje" se não for o dia civil atual desse recorte. Diga claramente que não há mensagens nesse intervalo.`,
        texto_cabecalho_ui: `0 mensagens — período solicitado: ${rot} (${RECORTE_TZ})`,
      }
    }
    return null
  }
  let minIso = list[0].criado_em
  let maxIso = list[0].criado_em
  for (const m of list) {
    if (m.criado_em < minIso) minIso = m.criado_em
    if (m.criado_em > maxIso) maxIso = m.criado_em
  }
  const keys = [...new Set(list.map((m) => calendarKeyInTz(m.criado_em)).filter(Boolean))].sort()
  const todayKey = calendarKeyNowSp()
  const minK = keys[0]
  const maxK = keys[keys.length - 1]
  const apenas_um_dia = minK === maxK
  const esse_dia_eh_hoje = minK === todayKey && maxK === todayKey
  const pode_usar_hoje = apenas_um_dia && esse_dia_eh_hoje
  const instrucao = pode_usar_hoje
    ? `Todas as mensagens em Dados.mensagens são do dia civil atual (${calendarKeyToBRLabel(todayKey)}, fuso ${RECORTE_TZ}). Pode usar "hoje" só se ficar explícito que se refere a essas mensagens; prefira citar a data (${calendarKeyToBRLabel(todayKey)}).`
    : `Datas reais das mensagens retornadas: de ${calendarKeyToBRLabel(minK)} a ${calendarKeyToBRLabel(maxK)} (fuso ${RECORTE_TZ}). É PROIBIDO usar "hoje", "ontem" ou "nesta conversa de hoje" para esse conjunto — use "nas mensagens retornadas", "no período analisado" ou cite ${calendarKeyToBRLabel(minK)}${minK !== maxK ? ` a ${calendarKeyToBRLabel(maxK)}` : ''}.`

  return {
    fuso: RECORTE_TZ,
    primeiro_criado_em: minIso,
    ultimo_criado_em: maxIso,
    primeiro_data_exibicao: formatDateTimeBR(minIso),
    ultimo_data_exibicao: formatDateTimeBR(maxIso),
    primeiro_dia_calendario: minK,
    ultimo_dia_calendario: maxK,
    dias_distintos_calendario: keys.length,
    pode_usar_hoje_no_texto: pode_usar_hoje,
    janela_consulta_dias: ctx?.periodo_dias ?? null,
    periodo_definido_na_requisicao: ctx?.periodo_explicito === true,
    instrucao_temporal_obrigatoria: instrucao,
    texto_cabecalho_ui: `Análise de ${list.length} mensagem(ns) — ${formatDateTimeBR(minIso)} → ${formatDateTimeBR(maxIso)} (${RECORTE_TZ})`,
  }
}

const RE_AUTO = /(escolha (um |o )?setor|digite (o |a )?n[uú]mero|menu principal|bem[-\s]?vindo|assistente virtual|chatbot|protocolo|avali(ar|e) (o |nosso )?atendimento|encerr(amos|ada)|transfer(ido|ência)|op[cç][aã]o inv[aá]lida)/i

function classificarMensagemParaResumo(m) {
  const tipo = String(m.tipo || 'texto').toLowerCase()
  const t = String(m.texto || '').trim()
  const tl = t.toLowerCase()
  const ehMidia = !!(m.url || m.nome_arquivo || ['imagem', 'image', 'audio', 'video', 'documento', 'sticker', 'location', 'ptt', 'document'].includes(tipo))
  let provavel_automatica = false
  if (!ehMidia && t.length > 0) {
    if (RE_AUTO.test(t)) provavel_automatica = true
    if (/^\d{1,2}\s*[-–.)]\s*\S/.test(tl) && t.length < 160) provavel_automatica = true
  }
  const sinal_baixo_valor = !ehMidia && t.length > 0 && t.length <= 4 && /^(oi|ok|opa|sim|n[aã]o|👍|👋)$/i.test(t)
  let peso_resumo = 2
  if (ehMidia) peso_resumo = 3
  else if (provavel_automatica) peso_resumo = 0
  else if (sinal_baixo_valor) peso_resumo = 1
  return {
    eh_midia: ehMidia,
    provavel_automatica,
    sinal_baixo_valor_informativo: sinal_baixo_valor,
    peso_resumo,
  }
}

function dedupeMensagensConsecutivasSemelhantes(mensagens) {
  const out = []
  let prev = null
  for (const m of mensagens || []) {
    const key = `${m.direcao}|${String(m.texto || '').trim().replace(/\s+/g, ' ').toLowerCase()}`
    if (prev === key) continue
    prev = key
    out.push(m)
  }
  return out
}

/** Acrescenta nota se o texto usar "hoje"/"ontem" sem recorte permitir. */
function sanearLinguagemTemporalIndevida(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const rt = data?.recorte_temporal
  if (!rt || typeof rt !== 'object') return answer
  const comMensagens = [
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'ANALISE_TOM_ATENDENTE',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
  ].includes(intent)
  const comRecorteConversas = ['HISTORICO_CLIENTE', 'HISTORICO_ATENDENTE', 'DETALHES_CONVERSA'].includes(intent)
  if (!comMensagens && !comRecorteConversas) return answer
  if (rt.pode_usar_hoje_no_texto === true) return answer
  const pat = /\b(hoje|ontem|nesta (manhã|tarde|noite) de hoje|conversa de hoje|mensagens de hoje)\b/i
  if (!pat.test(answer)) return answer
  const de = rt.primeiro_data_exibicao || rt.primeiro_dia_calendario
  const ate = rt.ultimo_data_exibicao || rt.ultimo_dia_calendario
  return `${answer.trim()}\n\n**Correção temporal:** As mensagens analisadas vão de **${de}** a **${ate}** (${rt.fuso}). Não use "hoje"/"ontem" para esse recorte.`
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

function questionHasExplicitDateRange(question) {
  const qRaw = String(question || '').trim()
  if (!qRaw) return false
  const q = qRaw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return /\bentre\s+\d{1,2}[\/\-]\d{1,2}/.test(q)
    || /\bde\s+\d{1,2}[\/\-]\d{1,2}\s+ate\s+\d{1,2}[\/\-]\d{1,2}/.test(q)
}

function enrichDataReferenciaFromQuestion(cls, question) {
  if (!question || typeof question !== 'string') return cls
  if (questionHasExplicitDateRange(question)) return cls
  const intentsComData = new Set([
    'BUSCA_CONTEUDO_MENSAGENS',
    'SINAIS_INTERESSE_COMPRA',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'CHAT_INTERNO_POR_TEMA',
    'ATENDENTE_MAIS_MENSAGENS_COM_TEMA',
    'RANKING_EDUCACAO_ATENDENTES',
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'DETALHES_CONVERSA',
    'HISTORICO_ATENDENTE',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
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
  let desde
  let ate = null
  if (opts.periodo_mensagens_inicio_iso && opts.periodo_mensagens_fim_exclusive_iso) {
    desde = opts.periodo_mensagens_inicio_iso
    ate = opts.periodo_mensagens_fim_exclusive_iso
  } else {
    const bounds = dataIso ? dayBoundsSpForIsoDate(dataIso) : null
    const desdePeriodo = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
    if (bounds) {
      desde = bounds.inicio > desdePeriodo ? bounds.inicio : desdePeriodo
      ate = bounds.fim
    } else {
      desde = desdePeriodo
    }
  }

  const rawTerms = Array.isArray(termos) ? termos : []
  const terms = expandTermosForSearch(rawTerms, 26)
  if (!terms.length) {
    return { error: 'Nenhum termo de busca válido foi identificado. Reformule com palavras-chave.', evidencias: [], periodo_dias: d }
  }

  let convFilterIds = null
  if (filtros.usuario_id) {
    let convRows = []
    if (opts.periodo_mensagens_inicio_iso && ate) {
      const { data: mU } = await supabase
        .from('mensagens')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('autor_usuario_id', filtros.usuario_id)
        .gte('criado_em', desde)
        .lt('criado_em', ate)
        .limit(500)
      convRows = [...new Set((mU || []).map((x) => x.conversa_id).filter(Boolean))].map((id) => ({ id }))
    } else {
      const { data: c1 } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .eq('atendente_id', filtros.usuario_id)
        .gte('criado_em', desde)
        .neq('tipo', 'grupo')
        .limit(450)
      convRows = c1 || []
    }
    convFilterIds = convRows.map((c) => c.id)
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
    let qC2 = supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('cliente_id', filtros.cliente_id)
      .neq('tipo', 'grupo')
    if (opts.periodo_mensagens_inicio_iso && ate) {
      qC2 = qC2.gte('ultima_atividade', desde).lt('ultima_atividade', ate)
    } else {
      qC2 = qC2.gte('criado_em', desde)
    }
    const { data: c2 } = await qC2.limit(450)
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

  let evidencias = rows.map((m) => {
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
  evidencias = filtrarPorCriadoEm(evidencias, desde, ate, 'criado_em')

  const periodoExplicitoBusca = !!(opts.periodo_fixado_na_pergunta
    || (opts.periodo_mensagens_inicio_iso && opts.periodo_mensagens_fim_exclusive_iso))

  const recorte_temporal = buildRecorteTemporalMeta(
    evidencias.map((e) => ({ criado_em: e.criado_em })),
    {
      periodo_dias: d,
      periodo_explicito: periodoExplicitoBusca,
      periodo_pedido_inicio_iso: opts.periodo_mensagens_inicio_iso || null,
      periodo_pedido_fim_exclusive_iso: opts.periodo_mensagens_fim_exclusive_iso || null,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    },
  )

  const outBusca = {
    evidencias,
    termos_usados: terms,
    periodo_dias: d,
    data_filtro: dataIso || null,
    total_retornado: evidencias.length,
    fonte: 'mensagens',
    recorte_temporal,
  }
  if (opts.periodo_mensagens_inicio_iso && opts.periodo_mensagens_fim_exclusive_iso) {
    outBusca.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: opts.periodo_mensagens_inicio_iso,
      fim_exclusive_iso: opts.periodo_mensagens_fim_exclusive_iso,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal_mensagens: 'mensagens.criado_em',
    }
  }
  return outBusca
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
async function qClientesPorTemaFinanceiro(company_id, days, dataIso, optsBusca = {}) {
  const terms = expandTermosForSearch(LEXICO_FINANCEIRO, 26)
  const busca = await qBuscaConteudoMensagens(company_id, terms, days, dataIso, { ...optsBusca, aplicar_filtro_robusto: true })
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
    recorte_temporal: busca.recorte_temporal || null,
    periodo_efetivo_consulta: busca.periodo_efetivo_consulta || null,
  }
}

/** CONVERSAS_POR_ASSUNTO_OPERACIONAL — agrupa conversas com ocorrências do léxico operacional + termos da pergunta. */
async function qConversasPorAssuntoOperacional(company_id, termos, days, dataIso, optsBusca = {}) {
  const merged = [...new Set([...(termos || []), ...LEXICO_OPERACIONAL])]
  const terms = expandTermosForSearch(merged, 26)
  const busca = await qBuscaConteudoMensagens(company_id, terms, days, dataIso, optsBusca)
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
    recorte_temporal: busca.recorte_temporal || null,
    periodo_efetivo_consulta: busca.periodo_efetivo_consulta || null,
  }
}

/**
 * ATENDENTE_MAIS_MENSAGENS_COM_TEMA — conta mensagens enviadas (out) por autor_usuario_id contendo o primeiro termo forte.
 */
async function qAtendentesMaisMensagensComTema(company_id, termos, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  let d = clampDays(days)
  let desde
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }
  const terms = expandTermosForSearch(termos || [], 24)
  if (!terms.length) {
    return { error: 'Informe um tema na pergunta (ex.: promoção, desconto).', ranking: [], periodo_dias: d }
  }
  const primary = terms[0]
  const orClause = terms.map((t) => `texto.ilike.%${t}%`).join(',')

  const msgs = await fetchMensagensPaged((from, to) => {
    let qM = supabase
      .from('mensagens')
      .select('id, autor_usuario_id, texto, criado_em')
      .eq('company_id', company_id)
      .eq('direcao', 'out')
      .gte('criado_em', desde)
      .or(orClause)
      .range(from, to)
    if (fxEx) qM = qM.lt('criado_em', fxEx)
    return qM
  }, { pageSize: 2000, maxRows: 50000 })

  let withAutor = (msgs || []).filter((m) => {
    if (!m.autor_usuario_id || !m.texto) return false
    return terms.some((t) => textoCasaTermoRobusto(m.texto, t))
  })
  withAutor = filtrarPorCriadoEm(withAutor, desde, fxEx || null, 'criado_em')
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

  const outTema = {
    ranking: ranking.slice(0, 15),
    termos_usados: terms,
    termo_principal: primary,
    periodo_dias: d,
    total_mensagens_classificadas: withAutor.length,
  }
  if (fxIn && fxEx) {
    outTema.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal_mensagens: 'mensagens.criado_em',
    }
    const rtCtx = {
      periodo_dias: d,
      periodo_explicito: true,
      periodo_pedido_inicio_iso: fxIn,
      periodo_pedido_fim_exclusive_iso: fxEx,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    }
    outTema.recorte_temporal = buildRecorteTemporalMeta(
      withAutor.map((m) => ({ criado_em: m.criado_em })),
      rtCtx,
    ) || buildRecorteTemporalMeta([], rtCtx)
  }
  return outTema
}

async function qRankingEducacaoAtendentes(company_id, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  let d = clampDays(days)
  let desde
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

  const msgs = await fetchMensagensPaged((from, to) => {
    let q = supabase
      .from('mensagens')
      .select('id, autor_usuario_id, texto, criado_em, conversa_id')
      .eq('company_id', company_id)
      .eq('direcao', 'out')
      .gte('criado_em', desde)
      .not('autor_usuario_id', 'is', null)
      .range(from, to)
    if (fxEx) q = q.lt('criado_em', fxEx)
    return q
  }, { pageSize: 1500, maxRows: 30000 })

  const validas = (msgs || []).filter((m) => m.autor_usuario_id && String(m.texto || '').trim())
  if (!validas.length) {
    return { ranking: [], periodo_dias: d, observacao: 'Sem mensagens enviadas por atendentes no período.' }
  }

  const agg = new Map()
  for (const m of validas) {
    const uid = m.autor_usuario_id
    if (!agg.has(uid)) agg.set(uid, { total: 0, pos: 0, neg: 0, exemplos: [] })
    const rec = agg.get(uid)
    const texto = String(m.texto || '').trim().slice(0, 220)
    const s = notaCordialidadePorMensagem(texto)
    rec.total += 1
    rec.pos += s.positivos
    rec.neg += s.negativos
    if ((s.positivos > 0 || s.negativos > 0) && rec.exemplos.length < 3) {
      rec.exemplos.push({
        mensagem_id: m.id,
        conversa_id: m.conversa_id,
        texto_preview: texto,
        positivos: s.positivos,
        negativos: s.negativos,
      })
    }
  }

  const ids = Array.from(agg.keys())
  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  const nomeMap = new Map((usuarios || []).map((u) => [u.id, u.nome || 'Sem nome']))

  const rankingBruto = Array.from(agg.entries())
    .map(([uid, rec]) => {
      const taxaPos = rec.total > 0 ? rec.pos / rec.total : 0
      const taxaNeg = rec.total > 0 ? rec.neg / rec.total : 0
      const nota = Math.max(0, Math.min(10, Number((5 + taxaPos * 4.5 - taxaNeg * 6.5).toFixed(2))))
      return {
        usuario_id: uid,
        nome: nomeMap.get(uid) || 'Sem nome',
        total_mensagens_analisadas: rec.total,
        sinais_cordiais: rec.pos,
        sinais_risco_linguagem: rec.neg,
        nota_cordialidade: nota,
        exemplos: rec.exemplos,
      }
    })
    .filter((r) => r.total_mensagens_analisadas >= 5)
    .sort((a, b) => (
      b.nota_cordialidade - a.nota_cordialidade
      || b.sinais_cordiais - a.sinais_cordiais
      || b.total_mensagens_analisadas - a.total_mensagens_analisadas
    ))

  return {
    ranking: rankingBruto.slice(0, 15),
    periodo_dias: d,
    total_atendentes_analisados: rankingBruto.length,
    total_mensagens_analisadas: validas.length,
    criterio: 'Ranking heurístico por sinais textuais: cordialidade (saudações/agradecimentos/polidez) menos sinais de fricção. Não substitui auditoria humana.',
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
async function qSinaisInteresseCompra(company_id, days, optsBusca = {}) {
  const termosLexico = expandTermosForSearch(LEXICO_COMERCIAL_COMPRA, 26)
  return qBuscaConteudoMensagens(company_id, termosLexico, days, null, optsBusca)
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
async function qRelatorioAtendenteCompleto(company_id, usuarioNome, days, opts = {}) {
  const historico = await qHistoricoAtendente(company_id, usuarioNome, days, opts)
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
    qTempoMedioRespostaAtendente(company_id, usuarioNome, days, opts),
    qAmostraTextosAtendente(company_id, usuarioNome, days, opts),
  ])
  return { historico_conversas: historico, tempo_primeira_resposta: tempo, amostra_mensagens_enviadas: tom, periodo_dias: clampDays(days) }
}

/**
 * MENSAGENS_USUARIO_CLIENTE: mensagens trocadas entre atendente e cliente (até 200).
 * opts.periodo_solicitado_explicitamente: true quando period_days veio no body da API (não inferido só pelo classificador).
 */
async function qMensagensUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const impedirFb = opts.impedir_fallback_mensagens_antigas === true
  const periodoExplicitoApi = opts.periodo_solicitado_explicitamente === true
  const periodoExplicito = periodoExplicitoApi || fixadoPergunta

  let d = clampDays(days)
  const temParAtendenteCliente = !!(usuarioNome && (clienteNome || clienteTelefone))
  if (temParAtendenteCliente && !periodoExplicito && !(fxIn && fxEx)) d = Math.max(d, 90)

  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    const span = Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000))
    d = Math.min(365, span)
  } else {
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }
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

  let convIdsFinal = []
  let criterio_resolucao = null

  if (usuario_id && (cliente_id || telefoneCliente)) {
    criterio_resolucao = 'atendente_ou_usuario_na_conversa_ou_autor_msg_ou_atendimentos_ou_historico'
    let qCli = supabase.from('conversas').select('id, telefone, tipo').eq('company_id', company_id)
    if (cliente_id) qCli = qCli.eq('cliente_id', cliente_id)
    else qCli = qCli.eq('telefone', telefoneCliente)
    const { data: clientConvsRaw } = await qCli.order('criado_em', { ascending: false }).limit(160)
    const clientConvIds = filtrarConversasIndividuais(clientConvsRaw).map((c) => c.id).filter(Boolean).slice(0, 120)
    if (!clientConvIds.length) {
      return {
        error: 'Nenhuma conversa individual encontrada para este cliente (excluídos grupos / @g.us).',
        mensagens: [],
        usuario: usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null,
        cliente: cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null,
        periodo_dias: d,
        criterio_resolucao: 'cliente_sem_conversa',
      }
    }
    let qMsgAut = supabase.from('mensagens').select('conversa_id').eq('company_id', company_id).in('conversa_id', clientConvIds)
      .eq('autor_usuario_id', usuario_id).eq('direcao', 'out').gte('criado_em', desde)
    if (ateExclusive) qMsgAut = qMsgAut.lt('criado_em', ateExclusive)
    let qAtend = supabase.from('atendimentos').select('conversa_id').eq('company_id', company_id).in('conversa_id', clientConvIds)
      .or(`para_usuario_id.eq.${usuario_id},de_usuario_id.eq.${usuario_id}`)
    if (fixadoPergunta && desde && ateExclusive) {
      qAtend = qAtend.gte('criado_em', desde).lt('criado_em', ateExclusive)
    }
    let qHist = supabase.from('historico_atendimentos').select('conversa_id').in('conversa_id', clientConvIds).eq('usuario_id', usuario_id)
    if (fixadoPergunta && desde && ateExclusive) {
      qHist = qHist.gte('criado_em', desde).lt('criado_em', ateExclusive)
    }
    const [{ data: convTitular }, { data: msgAutor }, { data: atendRows }, { data: histRows }] = await Promise.all([
      supabase.from('conversas').select('id').eq('company_id', company_id).in('id', clientConvIds)
        .or(`atendente_id.eq.${usuario_id},usuario_id.eq.${usuario_id}`),
      qMsgAut.limit(500),
      qAtend.limit(300),
      qHist.limit(400),
    ])
    const setIds = new Set()
    for (const c of convTitular || []) if (c?.id) setIds.add(c.id)
    for (const m of msgAutor || []) if (m?.conversa_id) setIds.add(m.conversa_id)
    for (const a of atendRows || []) if (a?.conversa_id) setIds.add(a.conversa_id)
    for (const h of histRows || []) if (h?.conversa_id) setIds.add(h.conversa_id)
    if (!setIds.size && !impedirFb) {
      let qM2 = supabase.from('mensagens').select('conversa_id').eq('company_id', company_id).in('conversa_id', clientConvIds)
        .eq('autor_usuario_id', usuario_id).eq('direcao', 'out').order('criado_em', { ascending: false })
      let qA2 = supabase.from('atendimentos').select('conversa_id').eq('company_id', company_id).in('conversa_id', clientConvIds)
        .or(`para_usuario_id.eq.${usuario_id},de_usuario_id.eq.${usuario_id}`).order('criado_em', { ascending: false })
      const [{ data: msgAutorAny }, { data: atendAny }] = await Promise.all([qM2.limit(120), qA2.limit(100)])
      for (const m of msgAutorAny || []) if (m?.conversa_id) setIds.add(m.conversa_id)
      for (const a of atendAny || []) if (a?.conversa_id) setIds.add(a.conversa_id)
    }
    convIdsFinal = [...setIds].slice(0, 25)
    if (!convIdsFinal.length) {
      return {
        error: 'Não foi encontrada conversa deste cliente ligada a este usuário por atendente_id, usuario_id na conversa, mensagens enviadas (autor_usuario_id), tabela atendimentos ou historico_atendimentos.',
        mensagens: [],
        usuario: usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null,
        cliente: cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null,
        periodo_dias: d,
        meta_diagnostico: { conversas_do_cliente: clientConvIds.length, janela_dias_efetiva: d },
        criterio_resolucao,
      }
    }
  } else {
    let qConv = supabase
      .from('conversas')
      .select('id, telefone, tipo')
      .eq('company_id', company_id)

    if (usuario_id) qConv = qConv.eq('atendente_id', usuario_id)
    if (cliente_id) qConv = qConv.eq('cliente_id', cliente_id)
    else if (telefoneCliente) qConv = qConv.eq('telefone', telefoneCliente)
    else {
      const { data: convByTel } = await supabase
        .from('conversas')
        .select('id, telefone, tipo')
        .eq('company_id', company_id)
      const convIdsAll = filtrarConversasIndividuais(convByTel).map((c) => c.id)
      if (convIdsAll.length === 0) return { error: 'Nenhuma conversa encontrada.', mensagens: [], usuario: null, cliente: null }
      qConv = qConv.in('id', convIdsAll)
    }

    const { data: convsRaw } = await qConv.limit(24)
    const convs = filtrarConversasIndividuais(convsRaw).slice(0, 10)
    if (!convs?.length) {
      return {
        error: 'Nenhuma conversa encontrada para os critérios informados. Verifique o nome do atendente e do cliente.',
        mensagens: [],
        usuario: usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null,
        cliente: cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null,
      }
    }
    convIdsFinal = convs.map((c) => c.id)
  }

  const selMsg = 'id, texto, direcao, criado_em, autor_usuario_id, remetente_nome, conversa_id, tipo, url, nome_arquivo'

  let qMsgs = supabase
    .from('mensagens')
    .select(selMsg)
    .eq('company_id', company_id)
    .in('conversa_id', convIdsFinal)
    .gte('criado_em', desde)
  if (ateExclusive) qMsgs = qMsgs.lt('criado_em', ateExclusive)
  let { data: msgs } = await qMsgs.order('criado_em', { ascending: true }).limit(limitMsgs)

  let recado_recuperacao = null
  if ((!msgs || msgs.length === 0) && convIdsFinal.length && usuario_id && (cliente_id || telefoneCliente) && !periodoExplicito && !impedirFb) {
    const { data: msgs2 } = await supabase
      .from('mensagens')
      .select(selMsg)
      .eq('company_id', company_id)
      .in('conversa_id', convIdsFinal)
      .order('criado_em', { ascending: false })
      .limit(100)
    msgs = (msgs2 || []).slice().reverse()
    if (msgs?.length) {
      recado_recuperacao = 'Não havia mensagens na janela de dias usada; foram incluídas até 100 mensagens mais recentes dessas conversas (período não fixado no body da requisição).'
    }
  }

  const usuarioMap = new Map()
  const autorIds = [...new Set((msgs || []).map((m) => m.autor_usuario_id).filter(Boolean))]
  if (autorIds.length) {
    const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
    for (const u of us || []) usuarioMap.set(u.id, u.nome)
  }

  let mensagensFormatadas = (msgs || []).map((m) => {
    const baseM = {
      mensagem_id: m.id,
      conversa_id: m.conversa_id,
      texto: m.texto,
      direcao: m.direcao,
      criado_em: m.criado_em,
      autor_usuario_id: m.autor_usuario_id != null ? Number(m.autor_usuario_id) : null,
      tipo: m.tipo || 'texto',
      url: m.url || null,
      nome_arquivo: m.nome_arquivo || null,
      remetente: m.direcao === 'out' ? (usuarioMap.get(m.autor_usuario_id) || 'Atendente') : (m.remetente_nome || 'Cliente'),
      papel: m.direcao === 'out' ? 'atendente_sistema' : 'cliente',
    }
    return { ...baseM, flags: classificarMensagemParaResumo({ ...m, tipo: baseM.tipo }) }
  })
  mensagensFormatadas = filtrarPorCriadoEm(mensagensFormatadas, desde, ateExclusive, 'criado_em')

  const mensagens_compactas = dedupeMensagensConsecutivasSemelhantes(mensagensFormatadas).slice(0, 80)
  const recorte_temporal = buildRecorteTemporalMeta(mensagensFormatadas, {
    periodo_dias: d,
    periodo_explicito: periodoExplicito,
    periodo_pedido_inicio_iso: fxIn || null,
    periodo_pedido_fim_exclusive_iso: fxEx || null,
    rotulo_pedido: opts.periodo_consulta_rotulo || null,
  })

  const usuario = usuario_id ? (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data : null
  const cliente = cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null

  const base = {
    mensagens: mensagensFormatadas,
    mensagens_compactas,
    total: mensagensFormatadas.length,
    usuario,
    cliente,
    periodo_dias: d,
    orientacao_resumo_ia: 'Priorize mensagens com flags.peso_resumo >= 2. Trate flags.provavel_automatica como roteiro/sistema (não como foco principal). Mídias (flags.eh_midia): cite tipo/arquivo. Evite repetir cumprimentos idênticos.',
    recorte_temporal,
  }
  if (fxIn && fxEx) {
    base.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal_mensagens: 'mensagens.criado_em',
    }
  }
  if (criterio_resolucao) base.criterio_resolucao = criterio_resolucao
  if (recado_recuperacao) base.recado_recuperacao = recado_recuperacao

  if (convIdsFinal.length && convIdsFinal.length <= 8) {
    const { data: cmeta } = await supabase
      .from('conversas')
      .select('id, cliente_id, ultima_atividade, status_atendimento, tipo, atendente_id, usuario_id')
      .eq('company_id', company_id)
      .in('id', convIdsFinal)
    if (cmeta?.length) base.conversas_envolvidas = cmeta
  }

  base.meta_limites_consulta = {
    max_mensagens_retorno: limitMsgs,
    conversas_ids_utilizadas: convIdsFinal,
    total_conversas_na_consulta: convIdsFinal.length,
  }

  return base
}

/** CONVERSAS_USUARIO_CLIENTE: resumo das conversas entre atendente e cliente. */
async function qConversasUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days, opts = {}) {
  const result = await qMensagensUsuarioCliente(company_id, usuarioNome, clienteNome, clienteTelefone, days, opts)
  if (result.error) return result
  const rt = result.recorte_temporal
  const trecho = rt ? ` Entre ${rt.primeiro_data_exibicao} e ${rt.ultimo_data_exibicao} (${rt.fuso}).` : ''
  return {
    ...result,
    resumo: `Total de ${result.mensagens.length} mensagem(ns) retornadas.${trecho}`,
  }
}

/**
 * HISTORICO_CLIENTE: conversas de um cliente (exclui grupos / @g.us).
 * opts.periodo_solicitado_explicitamente: quando false e sem period_days no body, janela mínima 90 dias + fallback sem data se vazio.
 */
async function qHistoricoCliente(company_id, clienteNome, clienteTelefone, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const impedirFb = opts.impedir_fallback_mensagens_antigas === true
  const periodoExplicito = opts.periodo_solicitado_explicitamente === true || fixadoPergunta

  let d = clampDays(days)
  let desde
  if (fxIn && fxEx) {
    desde = fxIn
    const span = Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000))
    d = Math.min(365, span)
  } else {
    if (!periodoExplicito) d = Math.max(d, 90)
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
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

  const sel = 'id, criado_em, ultima_atividade, status_atendimento, atendente_id, usuario_id, telefone, tipo'
  let qConv = supabase
    .from('conversas')
    .select(sel)
    .eq('company_id', company_id)
  if (fixadoPergunta && fxIn && fxEx) {
    qConv = qConv.gte('ultima_atividade', fxIn).lt('ultima_atividade', fxEx)
  } else {
    qConv = qConv.gte('criado_em', desde)
  }
  if (cliente_id) qConv = qConv.eq('cliente_id', cliente_id)
  else qConv = qConv.eq('telefone', telefoneCliente)

  const { data: convsRaw } = await qConv.order('criado_em', { ascending: false }).limit(80)
  let convs = filtrarConversasIndividuais(convsRaw)
  let recado_recuperacao = null
  if ((!convs || !convs.length) && !periodoExplicito && !impedirFb) {
    let q2 = supabase.from('conversas').select(sel).eq('company_id', company_id)
    if (cliente_id) q2 = q2.eq('cliente_id', cliente_id)
    else q2 = q2.eq('telefone', telefoneCliente)
    const { data: convs2 } = await q2.order('criado_em', { ascending: false }).limit(40)
    convs = filtrarConversasIndividuais(convs2)
    if (convs?.length) {
      recado_recuperacao = 'Incluídas conversas anteriores à janela de dias porque não havia registros no período e period_days não veio no body da requisição.'
    }
  }

  const cliente = cliente_id ? (await supabase.from('clientes').select('id, nome, pushname, telefone').eq('id', cliente_id).maybeSingle()).data : null
  if (!convs?.length) {
    const emptyOut = { conversas: [], cliente, cliente_id: cliente?.id ?? null, periodo_dias: d, recado_recuperacao }
    if (fxIn && fxEx) {
      emptyOut.periodo_efetivo_consulta = {
        fuso: RECORTE_TZ,
        inicio_iso: fxIn,
        fim_exclusive_iso: fxEx,
        rotulo: opts.periodo_consulta_rotulo || null,
        fonte_temporal: fixadoPergunta ? 'conversas.ultima_atividade' : 'conversas.criado_em',
      }
      emptyOut.recorte_temporal = buildRecorteTemporalMeta([], {
        periodo_dias: d,
        periodo_explicito: periodoExplicito,
        periodo_pedido_inicio_iso: fxIn,
        periodo_pedido_fim_exclusive_iso: fxEx,
        rotulo_pedido: opts.periodo_consulta_rotulo || null,
      })
    }
    return emptyOut
  }

  const atendenteIds = [...new Set(convs.map((c) => c.atendente_id).filter(Boolean))]
  const { data: usuarios } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', atendenteIds)
  const atendenteMap = new Map((usuarios || []).map((u) => [u.id, u.nome]))

  const conversasFormatadas = convs.map((c) => ({
    id: c.id,
    atendente_id: c.atendente_id ?? null,
    usuario_id_conversa: c.usuario_id ?? null,
    criado_em: c.criado_em,
    ultima_atividade: c.ultima_atividade ?? null,
    status_atendimento: c.status_atendimento,
    atendente_nome: atendenteMap.get(c.atendente_id) || '—',
  }))

  const out = { conversas: conversasFormatadas, cliente, cliente_id: cliente?.id ?? null, periodo_dias: d }
  if (recado_recuperacao) out.recado_recuperacao = recado_recuperacao
  if (fxIn && fxEx) {
    out.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal: fixadoPergunta ? 'conversas.ultima_atividade' : 'conversas.criado_em',
    }
    const rtCtx = {
      periodo_dias: d,
      periodo_explicito: periodoExplicito,
      periodo_pedido_inicio_iso: fxIn,
      periodo_pedido_fim_exclusive_iso: fxEx,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    }
    const listaMetaTempo = fixadoPergunta
      ? conversasFormatadas.map((c) => ({ criado_em: c.ultima_atividade || c.criado_em }))
      : conversasFormatadas.map((c) => ({ criado_em: c.criado_em }))
    out.recorte_temporal = buildRecorteTemporalMeta(listaMetaTempo, rtCtx) || buildRecorteTemporalMeta([], rtCtx)
  }
  return out
}

/**
 * HISTORICO_ATENDENTE: conversas em que o usuário aparece como atendente_id, usuario_id da conversa,
 * ou como autor de mensagem outbound no período (captura transferências / mensagens reais).
 * Agrega por cliente_id com contagens de mensagens no período efetivo.
 */
async function qHistoricoAtendente(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const periodoExplicito = opts.periodo_solicitado_explicitamente === true || fixadoPergunta

  const LIM_TITULAR = 2500
  const LIM_AUTOR_MSG_CONVIDS = 6000
  const MAX_LINHAS_CONTAGEM_MENSAGENS = 24000

  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    const span = Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000))
    d = Math.min(365, span)
  } else {
    if (!periodoExplicito) d = Math.max(d, 90)
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

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
    return { error: 'Atendente não encontrado. Informe o nome.', conversas: [], usuario: null, periodo_dias: d }
  }

  const sel = 'id, criado_em, ultima_atividade, status_atendimento, cliente_id, telefone, atendente_id, usuario_id, tipo'
  let qTit = supabase
    .from('conversas')
    .select(sel)
    .eq('company_id', company_id)
    .or(`atendente_id.eq.${usuario_id},usuario_id.eq.${usuario_id}`)
  if (fixadoPergunta && fxIn && fxEx) {
    qTit = qTit.gte('ultima_atividade', fxIn).lt('ultima_atividade', fxEx)
  } else {
    qTit = qTit.gte('criado_em', desde)
  }
  let qMsg = supabase
    .from('mensagens')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('autor_usuario_id', usuario_id)
    .eq('direcao', 'out')
    .gte('criado_em', desde)
  if (ateExclusive) qMsg = qMsg.lt('criado_em', ateExclusive)

  const [{ data: convTitular }, { data: msgRows }] = await Promise.all([
    qTit.order('criado_em', { ascending: false }).limit(LIM_TITULAR),
    qMsg.limit(LIM_AUTOR_MSG_CONVIDS),
  ])

  const rawTitularCount = (convTitular || []).length
  const rawAutorMsgCount = (msgRows || []).length

  const titularIndiv = filtrarConversasIndividuais(convTitular || [])
  const msgConvIds = [...new Set((msgRows || []).map((m) => m.conversa_id).filter(Boolean))]
  let convsMsg = []
  for (const ch of chunkArray(msgConvIds, 120)) {
    const { data: cm } = await supabase.from('conversas').select(sel).eq('company_id', company_id).in('id', ch)
    convsMsg.push(...filtrarConversasIndividuais(cm || []))
  }

  const byId = new Map()
  for (const c of titularIndiv) byId.set(c.id, c)
  for (const c of convsMsg) byId.set(c.id, c)
  let convs = [...byId.values()].sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))

  let recuperacaoSemPeriodo = false
  let recado_recuperacao = null
  if (!convs.length && !fixadoPergunta) {
    // Sem data explícita na pergunta: tenta recuperar as conversas mais recentes do atendente.
    const [{ data: convTitularRecentes }, { data: msgRowsRecentes }] = await Promise.all([
      supabase
        .from('conversas')
        .select(sel)
        .eq('company_id', company_id)
        .or(`atendente_id.eq.${usuario_id},usuario_id.eq.${usuario_id}`)
        .order('ultima_atividade', { ascending: false })
        .limit(600),
      supabase
        .from('mensagens')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('autor_usuario_id', usuario_id)
        .eq('direcao', 'out')
        .order('criado_em', { ascending: false })
        .limit(2000),
    ])

    const titularRecentes = filtrarConversasIndividuais(convTitularRecentes || [])
    const msgConvIdsRecentes = [...new Set((msgRowsRecentes || []).map((m) => m.conversa_id).filter(Boolean))]
    let convsMsgRecentes = []
    for (const ch of chunkArray(msgConvIdsRecentes, 120)) {
      const { data: cm } = await supabase.from('conversas').select(sel).eq('company_id', company_id).in('id', ch)
      convsMsgRecentes.push(...filtrarConversasIndividuais(cm || []))
    }
    const byIdRecentes = new Map()
    for (const c of titularRecentes) byIdRecentes.set(c.id, c)
    for (const c of convsMsgRecentes) byIdRecentes.set(c.id, c)
    convs = [...byIdRecentes.values()]
      .sort((a, b) => {
        const ta = Date.parse(a.ultima_atividade || a.criado_em || 0)
        const tb = Date.parse(b.ultima_atividade || b.criado_em || 0)
        return tb - ta
      })
      .slice(0, 500)

    if (convs.length) {
      recuperacaoSemPeriodo = true
      recado_recuperacao = 'Não houve registros na janela solicitada; exibindo as conversas mais recentes encontradas para o atendente (como você não informou data específica).'
    }
  }

  const allConvIds = convs.map((c) => c.id)
  const countByConv = new Map()
  let linhasLidasContagem = 0
  let truncadoContagemMensagens = false
  for (const ch of chunkArray(allConvIds, 100)) {
    if (!ch.length) continue
    if (linhasLidasContagem >= MAX_LINHAS_CONTAGEM_MENSAGENS) {
      truncadoContagemMensagens = true
      break
    }
    const limChunk = Math.min(5000, MAX_LINHAS_CONTAGEM_MENSAGENS - linhasLidasContagem)
    let qMc = supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', company_id)
      .in('conversa_id', ch)
    if (!recuperacaoSemPeriodo) qMc = qMc.gte('criado_em', desde)
    if (ateExclusive) qMc = qMc.lt('criado_em', ateExclusive)
    const { data: mrows } = await qMc.limit(limChunk)
    const rows = mrows || []
    linhasLidasContagem += rows.length
    if (rows.length >= limChunk) truncadoContagemMensagens = true
    for (const r of rows) {
      if (!r.conversa_id) continue
      countByConv.set(r.conversa_id, (countByConv.get(r.conversa_id) || 0) + 1)
    }
  }

  const total_mensagens_periodo = [...countByConv.values()].reduce((a, b) => a + b, 0)

  const clienteIds = [...new Set(convs.map((c) => c.cliente_id).filter(Boolean))]
  const { data: clientes } = await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', clienteIds)
  const clienteMap = new Map((clientes || []).map((c) => [c.id, c]))

  const usuario = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const conversasFormatadas = convs.map((c) => ({
    id: c.id,
    atendente_id: c.atendente_id ?? null,
    usuario_id_conversa: c.usuario_id ?? null,
    cliente_id: c.cliente_id ?? null,
    criado_em: c.criado_em,
    ultima_atividade: c.ultima_atividade ?? null,
    status_atendimento: c.status_atendimento,
    cliente_nome: c.cliente_id ? (getDisplayName(clienteMap.get(c.cliente_id)) || c.telefone) : c.telefone || '—',
    total_mensagens_no_periodo: countByConv.get(c.id) || 0,
  }))

  const agregadoMap = new Map()
  for (const c of convs) {
    const ck = c.cliente_id != null ? `c:${c.cliente_id}` : `t:${c.telefone || c.id}`
    const cl = c.cliente_id ? clienteMap.get(c.cliente_id) : null
    const nome = c.cliente_id ? (getDisplayName(cl) || c.telefone || '—') : (c.telefone || '—')
    const tel = c.cliente_id ? (cl?.telefone ?? null) : (c.telefone ?? null)
    if (!agregadoMap.has(ck)) {
      agregadoMap.set(ck, {
        cliente_id: c.cliente_id,
        nome,
        telefone: tel,
        ids_das_conversas: [],
        total_conversas: 0,
        total_mensagens: 0,
        status_conversas: new Set(),
        ultima_atividade: null,
      })
    }
    const ag = agregadoMap.get(ck)
    ag.ids_das_conversas.push(c.id)
    ag.total_conversas += 1
    ag.total_mensagens += countByConv.get(c.id) || 0
    if (c.status_atendimento) ag.status_conversas.add(String(c.status_atendimento))
    const ua = c.ultima_atividade || c.criado_em
    if (!ag.ultima_atividade || new Date(ua) > new Date(ag.ultima_atividade)) ag.ultima_atividade = ua
  }

  const agregado_por_cliente = [...agregadoMap.values()]
    .map((r) => ({
      cliente_id: r.cliente_id,
      nome: r.nome,
      telefone: r.telefone,
      ids_das_conversas: r.ids_das_conversas,
      total_conversas: r.total_conversas,
      total_mensagens: r.total_mensagens,
      status_conversas: [...r.status_conversas],
      ultima_atividade: r.ultima_atividade,
    }))
    .sort((a, b) => String(b.ultima_atividade || '').localeCompare(String(a.ultima_atividade || '')))

  const clientes_detalhes = agregado_por_cliente.map((r) => ({ ...r }))
  const titularHouveCorte = rawTitularCount >= LIM_TITULAR
  const autorMsgHouveCorte = rawAutorMsgCount >= LIM_AUTOR_MSG_CONVIDS
  const observacaoTruncagemLista =
    titularHouveCorte || autorMsgHouveCorte
      ? 'Possível lista de conversas incompleta: a consulta por titular da conversa ou por mensagens outbound do atendente atingiu o limite técnico. Não afirme lista completa de clientes sem checar meta_limites_historico_atendente.'
      : null

  const outHist = {
    conversas: conversasFormatadas,
    usuario,
    periodo_dias: d,
    criterio_resolucao: 'atendente_id_ou_usuario_id_conversa_ou_autor_mensagem_no_periodo',
    agregado_por_cliente,
    clientes_detalhes,
    totais_historico_atendente: {
      total_clientes_unicos: agregado_por_cliente.length,
      total_conversas: convs.length,
      total_mensagens: total_mensagens_periodo,
    },
    meta_limites_historico_atendente: {
      conversas_retornadas: convs.length,
      limite_query_titular: LIM_TITULAR,
      limite_conversas_descobertas_por_autor_msg: LIM_AUTOR_MSG_CONVIDS,
      registros_raw_query_titular: rawTitularCount,
      registros_raw_query_autor_msg: rawAutorMsgCount,
      titular_houve_corte_por_limite: titularHouveCorte,
      autor_msg_houve_corte_por_limite: autorMsgHouveCorte,
      observacao_truncagem_lista_conversas: observacaoTruncagemLista,
      linhas_lidas_para_contagem_mensagens: linhasLidasContagem,
      limite_linhas_contagem_mensagens: MAX_LINHAS_CONTAGEM_MENSAGENS,
      truncado_contagem_mensagens: truncadoContagemMensagens,
      observacao_truncagem: truncadoContagemMensagens
        ? 'A contagem de mensagens por conversa pode estar subestimada: há mais linhas em mensagens no período do que o limite de segurança da consulta.'
        : null,
    },
  }
  if (recado_recuperacao) outHist.recado_recuperacao = recado_recuperacao
  if (fxIn && fxEx) {
    outHist.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal: fixadoPergunta ? 'conversas.ultima_atividade + mensagens.criado_em (autor out)' : 'conversas.criado_em + mensagens.criado_em',
    }
    const rtCtx = {
      periodo_dias: d,
      periodo_explicito: periodoExplicito,
      periodo_pedido_inicio_iso: fxIn,
      periodo_pedido_fim_exclusive_iso: fxEx,
      rotulo_pedido: opts.periodo_consulta_rotulo || null,
    }
    const listaMeta = fixadoPergunta
      ? conversasFormatadas.map((c) => ({ criado_em: c.ultima_atividade || c.criado_em }))
      : conversasFormatadas.map((c) => ({ criado_em: c.criado_em }))
    outHist.recorte_temporal = buildRecorteTemporalMeta(listaMeta, rtCtx) || buildRecorteTemporalMeta([], rtCtx)
  }
  return outHist
}

/** Transferências registradas na tabela atendimentos (acao = transferiu) no período. */
async function qAtendimentosTransferidosPeriodo(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const periodoExplicito = opts.periodo_solicitado_explicitamente === true || fixadoPergunta
  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    if (!periodoExplicito) d = Math.max(d, 7)
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

  let uidFiltro = null
  let ambUsuario = null
  if (usuarioNome) {
    const res = await resolveUsuarioCandidates(company_id, usuarioNome)
    if (res.ambiguous) ambUsuario = res.candidatos
    else uidFiltro = res.id
  }
  if (ambUsuario?.length) {
    return { error: null, ambiguidade_usuario: ambUsuario, transferencias: [], periodo_dias: d, fonte: 'atendimentos' }
  }

  let q = supabase
    .from('atendimentos')
    .select('id, conversa_id, de_usuario_id, para_usuario_id, acao, criado_em, observacao')
    .eq('company_id', company_id)
    .eq('acao', 'transferiu')
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(450)
  if (ateExclusive) q = q.lt('criado_em', ateExclusive)
  const { data: rows, error } = await q
  if (error) throw error
  let list = rows || []
  if (uidFiltro) {
    list = list.filter((t) => Number(t.de_usuario_id) === Number(uidFiltro) || Number(t.para_usuario_id) === Number(uidFiltro))
  }

  const uids = [...new Set(list.flatMap((t) => [t.de_usuario_id, t.para_usuario_id]).filter((x) => x != null))]
  const { data: us } = uids.length
    ? await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', uids)
    : { data: [] }
  const nm = new Map((us || []).map((u) => [u.id, u.nome]))

  const transferencias = list.map((t) => ({
    atendimento_id: t.id,
    conversa_id: t.conversa_id,
    criado_em: t.criado_em,
    de_usuario_id: t.de_usuario_id,
    para_usuario_id: t.para_usuario_id,
    de_nome: t.de_usuario_id != null ? (nm.get(t.de_usuario_id) || '—') : '—',
    para_nome: t.para_usuario_id != null ? (nm.get(t.para_usuario_id) || '—') : '—',
    observacao: t.observacao || null,
  }))

  const LIM_TRANSF = 450
  const rawTransfCount = (rows || []).length
  const out = {
    transferencias,
    total: transferencias.length,
    periodo_dias: d,
    criterio_resolucao: "atendimentos.acao = 'transferiu' no período",
    fonte: 'atendimentos',
    observacao: 'Quem "terminou falando" com o cliente não está nesta tabela; veja conversas.atendente_id após a transferência.',
    meta_limites_transferencias: {
      limite_registros: LIM_TRANSF,
      registros_retornados: rawTransfCount,
      possivel_truncagem: rawTransfCount >= LIM_TRANSF,
      observacao:
        rawTransfCount >= LIM_TRANSF
          ? `Lista limitada aos ${LIM_TRANSF} registros mais recentes no período; pode haver mais transferências.`
          : null,
    },
  }
  if (fxIn && fxEx) {
    out.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal: 'atendimentos.criado_em',
    }
  }
  return out
}

/**
 * Clientes cuja conversa (individual, atribuída ao atendente) teve mensagem inbound no período
 * e nenhuma mensagem outbound com autor_usuario_id = atendente no mesmo período.
 */
async function qClientesMensagemSemRespostaAtendente(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const periodoExplicito = opts.periodo_solicitado_explicitamente === true || fixadoPergunta
  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    if (!periodoExplicito) d = Math.max(d, 7)
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

  if (!usuarioNome) {
    return { error: 'Informe o nome do atendente.', clientes_sem_resposta: [], periodo_dias: d }
  }
  const res = await resolveUsuarioCandidates(company_id, usuarioNome)
  if (res.ambiguous) return { error: null, ambiguidade_usuario: res.candidatos, clientes_sem_resposta: [], periodo_dias: d }
  if (!res.id) return { error: 'Atendente não encontrado.', clientes_sem_resposta: [], periodo_dias: d }
  const usuario_id = res.id

  let qIn = supabase
    .from('mensagens')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'in')
    .gte('criado_em', desde)
  if (ateExclusive) qIn = qIn.lt('criado_em', ateExclusive)
  const LIM_IN_SEM_RESPOSTA = 8000
  const { data: ins } = await qIn.limit(LIM_IN_SEM_RESPOSTA)
  const inTruncado = (ins || []).length >= LIM_IN_SEM_RESPOSTA
  const inConv = [...new Set((ins || []).map((m) => m.conversa_id).filter(Boolean))]
  const metaLimIn = {
    limite_mensagens_in: LIM_IN_SEM_RESPOSTA,
    mensagens_in_retornadas: (ins || []).length,
    possivel_truncagem_universo_in: inTruncado,
    observacao:
      inTruncado
        ? 'A amostra de mensagens inbound no período atingiu o limite técnico; a lista de clientes sem resposta pode estar incompleta.'
        : null,
  }
  if (!inConv.length) {
    return {
      clientes_sem_resposta: [],
      total: 0,
      periodo_dias: d,
      observacao: 'Nenhuma mensagem recebida de cliente (in) no período.',
      criterio_resolucao: 'in no período sem out do autor atendente na mesma conversa/período',
      meta_limites_sem_resposta: metaLimIn,
    }
  }

  let qOut = supabase
    .from('mensagens')
    .select('conversa_id')
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .eq('autor_usuario_id', usuario_id)
    .gte('criado_em', desde)
  if (ateExclusive) qOut = qOut.lt('criado_em', ateExclusive)
  const LIM_OUT_SEM_RESPOSTA = 8000
  const { data: outs } = await qOut.limit(LIM_OUT_SEM_RESPOSTA)
  const outTruncado = (outs || []).length >= LIM_OUT_SEM_RESPOSTA
  const outSet = new Set((outs || []).map((m) => m.conversa_id).filter(Boolean))

  const candidatos = []
  for (const ch of chunkArray(inConv, 100)) {
    const { data: convs } = await supabase
      .from('conversas')
      .select('id, cliente_id, telefone, atendente_id, status_atendimento, ultima_atividade')
      .eq('company_id', company_id)
      .in('id', ch)
    for (const c of filtrarConversasIndividuais(convs || [])) {
      if (Number(c.atendente_id) !== Number(usuario_id)) continue
      if (outSet.has(c.id)) continue
      candidatos.push(c)
    }
  }

  const cids = [...new Set(candidatos.map((c) => c.cliente_id).filter(Boolean))]
  const { data: clRows } = cids.length
    ? await supabase.from('clientes').select('id, nome, pushname, telefone').eq('company_id', company_id).in('id', cids)
    : { data: [] }
  const cmap = new Map((clRows || []).map((c) => [c.id, c]))

  const clientes_sem_resposta = candidatos.map((c) => {
    const cl = c.cliente_id ? cmap.get(c.cliente_id) : null
    return {
      conversa_id: c.id,
      cliente_id: c.cliente_id,
      nome: c.cliente_id ? (getDisplayName(cl) || c.telefone || '—') : (c.telefone || '—'),
      telefone: cl?.telefone ?? c.telefone ?? null,
      status_atendimento: c.status_atendimento,
      ultima_atividade: c.ultima_atividade,
    }
  })

  const usuario = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const out = {
    usuario,
    clientes_sem_resposta,
    total: clientes_sem_resposta.length,
    periodo_dias: d,
    criterio_resolucao: 'conversa com atendente_id = X, mensagem in no período, zero mensagens out com autor_usuario_id = X no período',
    observacao: 'Heurística de período: não prova que o atendente nunca respondeu fora do recorte.',
    meta_limites_sem_resposta: {
      ...metaLimIn,
      limite_mensagens_out_autor: LIM_OUT_SEM_RESPOSTA,
      mensagens_out_autor_retornadas: (outs || []).length,
      possivel_truncagem_universo_out: outTruncado,
      observacao_out:
        outTruncado
          ? 'A amostra de mensagens outbound do atendente no período atingiu o limite técnico; a exclusão de conversas "com resposta" pode estar afetada.'
          : null,
    },
  }
  if (fxIn && fxEx) {
    out.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal: 'mensagens.criado_em',
    }
  }
  return out
}

/** Mensagens outbound com autor_usuario_id = atendente no período (comprova envio real). */
async function qMensagensEnviadasAutorAtendente(company_id, usuarioNome, days, opts = {}) {
  const fxIn = opts.periodo_mensagens_inicio_iso || null
  const fxEx = opts.periodo_mensagens_fim_exclusive_iso || null
  const fixadoPergunta = opts.periodo_fixado_na_pergunta === true
  const periodoExplicito = opts.periodo_solicitado_explicitamente === true || fixadoPergunta
  let d = clampDays(days)
  let desde
  let ateExclusive = fxEx
  if (fxIn && fxEx) {
    desde = fxIn
    d = Math.min(365, Math.max(1, Math.ceil((Date.parse(fxEx) - Date.parse(fxIn)) / 86400000)))
  } else {
    if (!periodoExplicito) d = Math.max(d, 30)
    desde = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  }

  if (!usuarioNome) {
    return { error: 'Informe o nome do atendente.', mensagens: [], periodo_dias: d }
  }
  const res = await resolveUsuarioCandidates(company_id, usuarioNome)
  if (res.ambiguous) return { error: null, ambiguidade_usuario: res.candidatos, mensagens: [], periodo_dias: d }
  if (!res.id) return { error: 'Atendente não encontrado.', mensagens: [], periodo_dias: d }
  const usuario_id = res.id

  const sel = 'id, conversa_id, criado_em, texto, tipo, direcao, autor_usuario_id'
  let q = supabase
    .from('mensagens')
    .select(sel)
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .eq('autor_usuario_id', usuario_id)
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
  if (ateExclusive) q = q.lt('criado_em', ateExclusive)
  const LIM_MSG_AUTOR = 500
  const { data: msgs, error } = await q.limit(LIM_MSG_AUTOR)
  if (error) throw error

  const usuario = (await supabase.from('usuarios').select('id, nome').eq('id', usuario_id).maybeSingle()).data

  const mensagens = (msgs || []).map((m) => ({
    mensagem_id: m.id,
    conversa_id: m.conversa_id,
    criado_em: m.criado_em,
    autor_usuario_id: m.autor_usuario_id != null ? Number(m.autor_usuario_id) : null,
    direcao: m.direcao,
    tipo: m.tipo || 'texto',
    texto_preview: m.texto ? String(m.texto).trim().slice(0, 400) : '',
  }))

  const rawLen = (msgs || []).length
  const out = {
    usuario,
    mensagens,
    total: mensagens.length,
    periodo_dias: d,
    criterio_resolucao: 'mensagens.direcao=out e mensagens.autor_usuario_id = atendente',
    fonte: 'mensagens',
    observacao: rawLen >= LIM_MSG_AUTOR ? `Lista limitada a ${LIM_MSG_AUTOR} mensagens mais recentes no período.` : null,
    meta_limites_mensagens_autor: {
      limite_registros: LIM_MSG_AUTOR,
      registros_retornados: rawLen,
      possivel_truncagem: rawLen >= LIM_MSG_AUTOR,
    },
  }
  if (fxIn && fxEx) {
    out.periodo_efetivo_consulta = {
      fuso: RECORTE_TZ,
      inicio_iso: fxIn,
      fim_exclusive_iso: fxEx,
      rotulo: opts.periodo_consulta_rotulo || null,
      fonte_temporal: 'mensagens.criado_em',
    }
    out.recorte_temporal = buildRecorteTemporalMeta(
      mensagens.map((m) => ({ criado_em: m.criado_em })),
      {
        periodo_dias: d,
        periodo_explicito: periodoExplicito,
        periodo_pedido_inicio_iso: fxIn,
        periodo_pedido_fim_exclusive_iso: fxEx,
        rotulo_pedido: opts.periodo_consulta_rotulo || null,
      },
    )
  }
  return out
}

/** DETALHES_CONVERSA: quando não há id, usa histórico do cliente (mesma base que HISTORICO_CLIENTE). */
async function qDetalhesConversa(company_id, clienteNome, clienteTelefone, days, opts = {}) {
  return qHistoricoCliente(company_id, clienteNome, clienteTelefone, days, opts)
}

/** Metadados opcionais para o frontend (contrato estável: chave aditiva em data). */
function inferFonteDados(intent) {
  if (intent === 'CHAT_INTERNO_POR_TEMA') return 'internal_messages'
  if (intent === 'ATENDIMENTOS_TRANSFERIDOS') return 'atendimentos'
  if (intent === 'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR') return 'mensagens_whatsapp'
  if (intent === 'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE') return 'mensagens_whatsapp'
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

/** Foco semântico inferido da pergunta (não substitui o intent). */
function inferFocoPerguntaOperacional(question) {
  const q = String(question || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const focos = []
  if (/\b(todas as |todos os |liste |listar |quais |quantas conversas|conversa)\b/.test(q) || /\bconversas?\b/.test(q)) focos.push('conversas')
  if (/\b(mensagens?|enviou|mandou|escreveu|falou texto)\b/.test(q)) focos.push('mensagens')
  if (/\b(clientes?|com quem|quem |unicos?|únicos?|atendeu|falou com)\b/.test(q)) focos.push('clientes')
  if (!focos.length) focos.push('geral')
  return [...new Set(focos)]
}

function inferPeriodoTipoResumo(question, tscope, pec) {
  const q = String(question || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  if (/\bhoje\b|\bagora\b/.test(q)) return 'hoje'
  if (/\bontem\b/.test(q)) return 'ontem'
  if (/\besta semana\b|\bnesta semana\b/.test(q)) return 'semana_corrente'
  if (/\beste mes\b|\bneste mes\b/.test(q)) return 'mes_corrente'
  if (pec?.inicio_iso && pec?.fim_exclusive_iso) {
    const d1 = calendarKeyInTz(pec.inicio_iso)
    const d2 = calendarKeyInTz(new Date(Date.parse(pec.fim_exclusive_iso) - 1).toISOString())
    if (d1 === d2) return 'dia_unico'
    return 'intervalo'
  }
  if (tscope?.fixado_na_pergunta) return 'periodo_fixo_parser'
  return 'janela_rolagem_dias'
}

/** Metadado único de período para a IA (aditivo; não remove periodo_efetivo_consulta). */
function buildPeriodoEfetivoUsadoStruct(question, opts, tscope, periodoDefinidoNoBody, days) {
  const pec = opts?.periodo_mensagens_inicio_iso && opts?.periodo_mensagens_fim_exclusive_iso
    ? {
        inicio_iso: opts.periodo_mensagens_inicio_iso,
        fim_exclusive_iso: opts.periodo_mensagens_fim_exclusive_iso,
        rotulo: opts.periodo_consulta_rotulo || null,
      }
    : null
  const explicito = !!(periodoDefinidoNoBody || tscope?.fixado_na_pergunta)
  let dataInicial = null
  let dataFinalInclusiva = null
  if (pec) {
    dataInicial = calendarKeyInTz(pec.inicio_iso)
    dataFinalInclusiva = calendarKeyInTz(new Date(Date.parse(pec.fim_exclusive_iso) - 1).toISOString())
  }
  return {
    periodo_tipo: inferPeriodoTipoResumo(question, tscope, pec),
    data_inicial_efetiva: dataInicial,
    data_final_efetiva: dataFinalInclusiva,
    data_inicial_iso_utc: pec?.inicio_iso || null,
    data_final_exclusive_iso_utc: pec?.fim_exclusive_iso || null,
    timezone_usado: RECORTE_TZ,
    periodo_explicito_pedido_pelo_usuario: explicito,
    periodo_foi_default_nao_explicito: !explicito,
    periodo_dias_janela_rolagem: pec ? null : days,
    rotulo_amigavel: pec?.rotulo || null,
  }
}

function buildAmbiguidadesStruct(data) {
  const out = { usuario: null, cliente: null }
  if (data?.ambiguidade_usuario?.length) {
    out.usuario = { tipo: 'usuario', candidatos: data.ambiguidade_usuario.map((u) => ({ usuario_id: u.id, nome: u.nome })) }
  }
  if (data?.ambiguidade_cliente?.length) {
    out.cliente = { tipo: 'cliente', candidatos: data.ambiguidade_cliente.map((c) => ({ cliente_id: c.id, nome: c.nome || c.pushname, telefone: c.telefone })) }
  }
  const h = data?.historico_conversas
  if (h?.ambiguidade_usuario?.length && !out.usuario) {
    out.usuario = { tipo: 'usuario', candidatos: h.ambiguidade_usuario.map((u) => ({ usuario_id: u.id, nome: u.nome })), origem: 'historico_conversas' }
  }
  if (h?.ambiguidade_cliente?.length && !out.cliente) {
    out.cliente = { tipo: 'cliente', candidatos: h.ambiguidade_cliente.map((c) => ({ cliente_id: c.id, nome: c.nome || c.pushname, telefone: c.telefone })), origem: 'historico_conversas' }
  }
  return out
}

function contagemPorAutorMensagens(mensagens) {
  const map = new Map()
  for (const m of mensagens || []) {
    if (m.direcao !== 'out') continue
    const aid = m.autor_usuario_id != null ? Number(m.autor_usuario_id) : null
    if (aid == null || Number.isNaN(aid)) continue
    map.set(aid, (map.get(aid) || 0) + 1)
  }
  return [...map.entries()].map(([usuario_id, quantidade_mensagens_out]) => ({ usuario_id, quantidade_mensagens_out }))
}

async function resumoOperacionalMensagensUsuarioCliente(company_id, data) {
  const mensagens = data.mensagens || []
  let convMeta = data.conversas_envolvidas || []
  if (!convMeta.length && mensagens.length) {
    const ids = [...new Set(mensagens.map((m) => m.conversa_id).filter(Boolean))].slice(0, 80)
    if (ids.length) {
      const { data: crows } = await supabase
        .from('conversas')
        .select('id, cliente_id, ultima_atividade, status_atendimento, tipo, atendente_id, usuario_id')
        .eq('company_id', company_id)
        .in('id', ids)
      convMeta = crows || []
    }
  }
  const conversas_encontradas = [...new Set(mensagens.map((m) => m.conversa_id).filter(Boolean))]
  const clienteIdsMeta = [...new Set(convMeta.map((c) => c.cliente_id).filter(Boolean))]
  const clienteMap = new Map()
  if (clienteIdsMeta.length) {
    const { data: rows } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .in('id', clienteIdsMeta)
    for (const c of rows || []) clienteMap.set(c.id, c)
  }
  if (data.cliente?.id && !clienteMap.has(data.cliente.id)) {
    clienteMap.set(data.cliente.id, data.cliente)
  }
  const clientes_unicos = [...clienteMap.keys()]
  const clientes_detalhes = clientes_unicos.map((id) => {
    const c = clienteMap.get(id)
    return {
      cliente_id: id,
      nome_exibicao: c ? (getDisplayName(c) || c.telefone || String(id)) : String(id),
      telefone: c?.telefone ?? null,
    }
  })
  const conversas_detalhes = convMeta.map((c) => ({
    conversa_id: c.id,
    cliente_id: c.cliente_id ?? null,
    status_atendimento: c.status_atendimento ?? null,
    ultima_atividade: c.ultima_atividade ?? null,
    atendente_id_conversa: c.atendente_id ?? null,
    usuario_id_conversa: c.usuario_id ?? null,
    tipo: c.tipo ?? null,
  }))
  const uidFoco = data.usuario?.id
  const mensagens_out_atendente_foco = uidFoco != null
    ? mensagens.filter((m) => m.direcao === 'out' && Number(m.autor_usuario_id) === Number(uidFoco)).length
    : mensagens.filter((m) => m.direcao === 'out').length
  return {
    clientes_unicos,
    clientes_detalhes,
    conversas_encontradas,
    conversas_detalhes,
    mensagens_encontradas: mensagens.map((m) => m.mensagem_id).filter(Boolean),
    mensagens_detalhes: 'Ver Dados.mensagens (lista completa no mesmo payload).',
    total_clientes_unicos: clientes_unicos.length,
    total_conversas: conversas_encontradas.length,
    total_mensagens: mensagens.length,
    mensagens_outbound_no_periodo: mensagens_out_atendente_foco,
    contagem_por_autor_out: contagemPorAutorMensagens(mensagens),
    meta_limites: data.meta_limites_consulta || null,
    distincao_entidades: 'cliente = pessoa cadastrada; conversa = thread WhatsApp (conversa_id); mensagem = linha em Dados.mensagens; atendente da conversa pode diferir de autor_usuario_id da mensagem (transferências).',
  }
}

function resumoOperacionalHistoricoCliente(data) {
  const convs = data.conversas || []
  const cid = data.cliente_id ?? data.cliente?.id ?? null
  const clientes_unicos = cid ? [cid] : []
  const nome = data.cliente ? (getDisplayName(data.cliente) || data.cliente.telefone) : null
  const clientes_detalhes = cid
    ? [{ cliente_id: cid, nome_exibicao: nome || String(cid), telefone: data.cliente?.telefone ?? null }]
    : []
  const conversas_encontradas = convs.map((c) => c.id)
  const conversas_detalhes = convs.map((c) => ({
    conversa_id: c.id,
    cliente_id: cid,
    status_atendimento: c.status_atendimento ?? null,
    ultima_atividade: c.ultima_atividade ?? null,
    criado_em: c.criado_em ?? null,
    atendente_id_conversa: c.atendente_id ?? null,
    atendente_nome: c.atendente_nome ?? null,
  }))
  return {
    clientes_unicos,
    clientes_detalhes,
    conversas_encontradas,
    conversas_detalhes,
    mensagens_encontradas: [],
    mensagens_detalhes: 'Histórico por conversa; mensagens não carregadas neste intent (use MENSAGENS_USUARIO_CLIENTE ou BUSCA para texto).',
    total_clientes_unicos: clientes_unicos.length,
    total_conversas: convs.length,
    total_mensagens: 0,
    distincao_entidades: 'Aqui o foco é conversas do cliente no período; não confunda com contagem de mensagens.',
  }
}

function resumoOperacionalHistoricoAtendente(data) {
  const tot = data.totais_historico_atendente || {}
  const convs = data.conversas || []
  if (Array.isArray(data.agregado_por_cliente) && data.agregado_por_cliente.length) {
    const ag = data.agregado_por_cliente
    const clientes_unicos = ag.map((r) => r.cliente_id).filter((x) => x != null)
    const clientes_detalhes = ag.map((r) => ({
      cliente_id: r.cliente_id,
      nome: r.nome || String(r.cliente_id),
      nome_exibicao: r.nome || String(r.cliente_id),
      telefone: r.telefone ?? null,
      total_conversas: r.total_conversas,
      total_mensagens: r.total_mensagens,
      status_conversas: r.status_conversas,
      ultima_atividade: r.ultima_atividade,
      ids_das_conversas: r.ids_das_conversas,
    }))
    const conversas_encontradas = convs.map((c) => c.id)
    const conversas_detalhes = convs.map((c) => ({
      conversa_id: c.id,
      cliente_id: c.cliente_id ?? null,
      cliente_nome: c.cliente_nome ?? null,
      total_mensagens_no_periodo: c.total_mensagens_no_periodo ?? null,
      status_atendimento: c.status_atendimento ?? null,
      ultima_atividade: c.ultima_atividade ?? null,
      criado_em: c.criado_em ?? null,
    }))
    return {
      clientes_unicos,
      clientes_detalhes,
      conversas_encontradas,
      conversas_detalhes,
      mensagens_encontradas: [],
      mensagens_detalhes: 'Contagem por conversa em total_mensagens_no_periodo e agregado_por_cliente.total_mensagens (mensagens.criado_em no período).',
      total_clientes_unicos: tot.total_clientes_unicos ?? clientes_unicos.length,
      total_conversas: tot.total_conversas ?? convs.length,
      total_mensagens: tot.total_mensagens ?? 0,
      meta_limites: data.meta_limites_historico_atendente || null,
      distincao_entidades: 'Cliente agregado: total_conversas e total_mensagens por cliente no período; confira meta_limites se houver truncagem na contagem.',
    }
  }
  const clientePorId = new Map()
  for (const c of convs) {
    if (c.cliente_id) clientePorId.set(c.cliente_id, c.cliente_nome || null)
  }
  const clientes_unicos = [...clientePorId.keys()]
  const clientes_detalhes = clientes_unicos.map((id) => ({
    cliente_id: id,
    nome_exibicao: clientePorId.get(id) || String(id),
    telefone: null,
  }))
  const conversas_encontradas = convs.map((c) => c.id)
  const conversas_detalhes = convs.map((c) => ({
    conversa_id: c.id,
    cliente_id: c.cliente_id ?? null,
    cliente_nome: c.cliente_nome ?? null,
    status_atendimento: c.status_atendimento ?? null,
    ultima_atividade: c.ultima_atividade ?? null,
    criado_em: c.criado_em ?? null,
  }))
  return {
    clientes_unicos,
    clientes_detalhes,
    conversas_encontradas,
    conversas_detalhes,
    mensagens_encontradas: [],
    mensagens_detalhes: 'Lista de conversas; mensagens não expandidas (use BUSCA ou MENSAGENS_USUARIO_CLIENTE para conteúdo).',
    total_clientes_unicos: clientes_unicos.length,
    total_conversas: convs.length,
    total_mensagens: 0,
    meta_limites: data.meta_limites_historico_atendente || null,
    distincao_entidades: 'cliente_nome vem do cadastro/pushname na conversa; uma conversa por id; não é contagem de mensagens.',
  }
}

function resumoOperacionalTransferencias(data) {
  const rows = data.transferencias || []
  const convs = [...new Set(rows.map((r) => r.conversa_id).filter(Boolean))]
  return {
    clientes_unicos: [],
    clientes_detalhes: [],
    conversas_encontradas: convs,
    conversas_detalhes: rows,
    mensagens_encontradas: [],
    mensagens_detalhes: 'Eventos na tabela atendimentos (acao transferiu).',
    total_clientes_unicos: 0,
    total_conversas: convs.length,
    total_mensagens: rows.length,
    meta_limites_transferencias: data.meta_limites_transferencias || null,
    distincao_entidades: 'Cada item é um registro de transferência, não uma mensagem de chat.',
  }
}

function resumoOperacionalSemResposta(data) {
  const rows = data.clientes_sem_resposta || []
  const cids = [...new Set(rows.map((r) => r.cliente_id).filter(Boolean))]
  return {
    clientes_unicos: cids,
    clientes_detalhes: rows.map((r) => ({
      cliente_id: r.cliente_id,
      nome: r.nome || String(r.cliente_id),
      nome_exibicao: r.nome || String(r.cliente_id),
      telefone: r.telefone,
      conversa_id: r.conversa_id,
    })),
    conversas_encontradas: rows.map((r) => r.conversa_id),
    conversas_detalhes: rows,
    mensagens_encontradas: [],
    mensagens_detalhes: 'Heurística: in no período sem out do autor no período na conversa do atendente.',
    total_clientes_unicos: cids.length,
    total_conversas: rows.length,
    total_mensagens: 0,
    meta_limites_sem_resposta: data.meta_limites_sem_resposta || null,
    distincao_entidades: 'Indica ausência de resposta do atendente no recorte; não prova ausência fora do período.',
  }
}

function resumoOperacionalMensagensAutor(data) {
  const m = data.mensagens || []
  return {
    clientes_unicos: [],
    clientes_detalhes: [],
    conversas_encontradas: [...new Set(m.map((x) => x.conversa_id).filter(Boolean))],
    conversas_detalhes: [],
    mensagens_encontradas: m.map((x) => x.mensagem_id),
    mensagens_detalhes: 'Mensagens com autor_usuario_id = atendente (envio real).',
    total_clientes_unicos: 0,
    total_conversas: new Set(m.map((x) => x.conversa_id).filter(Boolean)).size,
    total_mensagens: m.length,
    meta_limites_mensagens_autor: data.meta_limites_mensagens_autor || null,
    distincao_entidades: 'Somente mensagens outbound cujo autor_usuario_id é o atendente.',
  }
}

function resumoOperacionalBusca(data) {
  const ev = data.evidencias || []
  const convs = [...new Set(ev.map((e) => e.conversa_id).filter(Boolean))]
  const clis = [...new Set(ev.map((e) => e.cliente_id).filter(Boolean))]
  const clientes_detalhes = clis.map((id) => ({ cliente_id: id, nome_exibicao: String(id), telefone: null }))
  return {
    clientes_unicos: clis,
    clientes_detalhes,
    conversas_encontradas: convs,
    conversas_detalhes: ev.slice(0, 80).map((e) => ({
      conversa_id: e.conversa_id,
      mensagem_id: e.mensagem_id,
      cliente_id: e.cliente_id,
      criado_em: e.criado_em,
      remetente: e.remetente,
      texto_preview: e.texto_preview,
    })),
    mensagens_encontradas: ev.map((e) => e.mensagem_id).filter(Boolean),
    mensagens_detalhes: 'Evidências completas em Dados.evidencias.',
    total_clientes_unicos: clis.length,
    total_conversas: convs.length,
    total_mensagens: ev.length,
    distincao_entidades: 'Cada evidência é uma mensagem que casou com o termo; total_mensagens = evidências.',
  }
}

function resumoOperacionalClientesTema(data) {
  const rows = data.clientes || []
  const ids = rows.map((r) => r.cliente_id).filter(Boolean)
  return {
    clientes_unicos: [...new Set(ids)],
    clientes_detalhes: rows.map((r) => ({
      cliente_id: r.cliente_id,
      nome_exibicao: r.nome || String(r.cliente_id),
      telefone: r.telefone ?? null,
      mensagens_com_tema: r.mensagens_com_tema,
      conversas_distintas: r.conversas_distintas,
    })),
    conversas_encontradas: [],
    conversas_detalhes: [],
    mensagens_encontradas: [],
    mensagens_detalhes: 'Agregado por cliente; ver total_evidencias_analisadas.',
    total_clientes_unicos: rows.length,
    total_conversas: rows.reduce((a, r) => a + (Number(r.conversas_distintas) || 0), 0),
    total_mensagens: data.total_evidencias_analisadas ?? 0,
    distincao_entidades: 'Ranking por cliente; mensagens_com_tema conta ocorrências de texto, não necessariamente msgs únicas.',
  }
}

function resumoOperacionalConversasAssunto(data) {
  const rows = data.conversas || []
  const cids = [...new Set(rows.map((r) => r.cliente_id).filter(Boolean))]
  const cmap = new Map()
  for (const r of rows) {
    if (r.cliente_id != null && !cmap.has(r.cliente_id)) {
      cmap.set(r.cliente_id, { cliente_id: r.cliente_id, nome_exibicao: r.cliente_nome || String(r.cliente_id) })
    }
  }
  return {
    clientes_unicos: cids,
    clientes_detalhes: [...cmap.values()],
    conversas_encontradas: rows.map((r) => r.conversa_id),
    conversas_detalhes: rows,
    mensagens_encontradas: [],
    mensagens_detalhes: 'Agrupado por conversa com ocorrências do tema.',
    total_clientes_unicos: cids.length,
    total_conversas: rows.length,
    total_mensagens: rows.reduce((a, r) => a + (Number(r.ocorrencias) || 0), 0),
    distincao_entidades: 'ocorrencias = mensagens que casaram por conversa.',
  }
}

function resumoOperacionalRelatorio(data) {
  const h = data.historico_conversas
  if (!h || typeof h !== 'object') {
    return {
      clientes_unicos: [],
      clientes_detalhes: [],
      conversas_encontradas: [],
      conversas_detalhes: [],
      mensagens_encontradas: [],
      mensagens_detalhes: null,
      total_clientes_unicos: 0,
      total_conversas: 0,
      total_mensagens: 0,
      distincao_entidades: 'Relatório parcial ou vazio.',
    }
  }
  const base = resumoOperacionalHistoricoAtendente(h)
  const amostra = data.amostra_mensagens_enviadas?.amostra || []
  return {
    ...base,
    total_mensagens_amostra_tom: amostra.length,
    mensagens_detalhes: `Histórico = conversas do atendente; amostra_mensagens_enviadas contém ${amostra.length} mensagens para análise de tom (subconjunto).`,
    subconjuntos_relatorio: {
      historico_conversas: { total_clientes_unicos: base.total_clientes_unicos, total_conversas: base.total_conversas },
      amostra_analise_tom: { total_mensagens: amostra.length },
      tempo_medio_primeira_resposta_min: data.tempo_primeira_resposta?.tempo_medio_min ?? null,
    },
  }
}

function buildInstrucaoContagensParaModelo(r, foco, question, intent) {
  const q = String(question || '').toLowerCase()
  const pediuTodos = /\b(todos|todas|sem omitir|completo|lista completa)\b/.test(q)
  const parts = []
  if (r.total_clientes_unicos > 1) {
    parts.push(`Foram identificados ${r.total_clientes_unicos} clientes distintos (total_clientes_unicos). Não diga que houve apenas um cliente. Liste nomes em clientes_detalhes ou equivalente.`)
  }
  if (r.total_conversas > 1) {
    parts.push(`Há ${r.total_conversas} conversas distintas (conversa_id). Não reduza a uma única conversa.`)
  }
  if (intent === 'ATENDIMENTOS_TRANSFERIDOS' && r.total_mensagens > 1) {
    parts.push(
      `Há ${r.total_mensagens} registros em transferências (total_mensagens neste resumo = linhas em Dados.transferencias), não mensagens WhatsApp. Não diga "uma mensagem" no sentido de chat.`,
    )
  } else if (r.total_mensagens > 1) {
    parts.push(`Há ${r.total_mensagens} mensagens no payload (total_mensagens). Não diga "uma mensagem" ou "duas" se o número for maior.`)
  }
  if (pediuTodos && (r.total_clientes_unicos > 0 || r.total_conversas > 0)) {
    parts.push('O usuário pediu "todos/todas": cite todos os itens em clientes_detalhes / conversas_detalhes (ou listas equivalentes), não apenas um exemplo.')
  }
  if (foco.includes('clientes') && r.clientes_detalhes?.length) {
    parts.push('Priorize responder com clientes únicos e nomes em clientes_detalhes.')
  }
  if (foco.includes('conversas') && r.conversas_detalhes?.length) {
    parts.push('Priorize conversa_id e status em conversas_detalhes.')
  }
  if (foco.includes('mensagens') && r.total_mensagens > 0) {
    parts.push('Priorize contagem e trechos de mensagens; não confunda com número de clientes.')
  }
  const ml = r.meta_limites && typeof r.meta_limites === 'object' ? r.meta_limites : null
  if (ml?.titular_houve_corte_por_limite || ml?.autor_msg_houve_corte_por_limite) {
    parts.push(
      'meta_limites: possível truncagem da lista de conversas (titular ou descoberta por mensagens do autor); não afirme lista completa de clientes sem revisar as flags.',
    )
  }
  if (ml?.truncado_contagem_mensagens) {
    parts.push('truncado_contagem_mensagens: totais de mensagens por cliente podem estar subestimados.')
  }
  if (r.meta_limites_transferencias?.possivel_truncagem) {
    parts.push('Transferências: lista pode estar truncada (ver meta_limites_transferencias).')
  }
  if (r.meta_limites_sem_resposta?.possivel_truncagem_universo_in || r.meta_limites_sem_resposta?.possivel_truncagem_universo_out) {
    parts.push('Sem resposta: heurística pode estar incompleta (limites em meta_limites_sem_resposta).')
  }
  if (r.meta_limites_mensagens_autor?.possivel_truncagem) {
    parts.push('Mensagens do autor: lista pode estar truncada (ver meta_limites_mensagens_autor).')
  }
  return parts.join(' ')
}

async function attachResumoOperacionalParaIa(company_id, data, intent, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const { question, optsPeriodoApi, tscope, periodoDefinidoNoBody, days } = ctx
  const periodo_efetivo_usado = buildPeriodoEfetivoUsadoStruct(question, optsPeriodoApi, tscope, periodoDefinidoNoBody, days)
  const foco = inferFocoPerguntaOperacional(question)
  const filtros_aplicados = {
    periodo_dias_relativo: data.periodo_dias ?? days,
    periodo_fixado_opts: optsPeriodoApi?.periodo_fixado_na_pergunta === true,
    usuario_nome_contexto: data.usuario?.nome ?? data.historico_conversas?.usuario?.nome ?? null,
    cliente_nome_contexto: data.cliente?.nome ?? data.cliente?.pushname ?? null,
    criterio_resolucao: data.criterio_resolucao || data.historico_conversas?.criterio_resolucao || null,
    recado_recuperacao: data.recado_recuperacao || data.historico_conversas?.recado_recuperacao || null,
  }
  const ambiguidades_detectadas = buildAmbiguidadesStruct(data)
  const alertas_analiticos = []
  if (data.observacao) alertas_analiticos.push({ tipo: 'observacao', texto: data.observacao })
  if (data.recado_recuperacao) alertas_analiticos.push({ tipo: 'recuperacao_fora_periodo', texto: data.recado_recuperacao })

  let bloco = null
  try {
    switch (intent) {
      case 'MENSAGENS_USUARIO_CLIENTE':
      case 'CONVERSAS_USUARIO_CLIENTE':
        bloco = await resumoOperacionalMensagensUsuarioCliente(company_id, data)
        break
      case 'HISTORICO_CLIENTE':
      case 'DETALHES_CONVERSA':
        bloco = resumoOperacionalHistoricoCliente(data)
        break
      case 'HISTORICO_ATENDENTE':
        bloco = resumoOperacionalHistoricoAtendente(data)
        break
      case 'ATENDIMENTOS_TRANSFERIDOS':
        bloco = resumoOperacionalTransferencias(data)
        break
      case 'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE':
        bloco = resumoOperacionalSemResposta(data)
        break
      case 'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR':
        bloco = resumoOperacionalMensagensAutor(data)
        break
      case 'BUSCA_CONTEUDO_MENSAGENS':
      case 'SINAIS_INTERESSE_COMPRA':
        bloco = resumoOperacionalBusca(data)
        break
      case 'CLIENTES_POR_TEMA_FINANCEIRO':
        bloco = resumoOperacionalClientesTema(data)
        break
      case 'CONVERSAS_POR_ASSUNTO_OPERACIONAL':
        bloco = resumoOperacionalConversasAssunto(data)
        break
      case 'ATENDENTE_MAIS_MENSAGENS_COM_TEMA': {
        const rank = data.ranking || []
        bloco = {
          clientes_unicos: [],
          clientes_detalhes: [],
          conversas_encontradas: [],
          conversas_detalhes: [],
          mensagens_encontradas: [],
          mensagens_detalhes: 'Ranking por atendente com mensagens outbound que casaram com o tema.',
          total_clientes_unicos: 0,
          total_conversas: 0,
          total_mensagens: data.total_mensagens_classificadas || 0,
          ranking_por_atendente: rank.map((r) => ({ usuario_id: r.usuario_id, nome: r.nome, mensagens_com_tema: r.mensagens_com_tema })),
          distincao_entidades: 'Ranking de atendentes por volume de mensagens (out) com o tema; não é contagem de clientes.',
        }
        break
      }
      case 'RANKING_EDUCACAO_ATENDENTES': {
        const rank = data.ranking || []
        bloco = {
          clientes_unicos: [],
          clientes_detalhes: [],
          conversas_encontradas: [],
          conversas_detalhes: [],
          mensagens_encontradas: [],
          mensagens_detalhes: 'Ranking de cordialidade por atendente com sinais textuais identificados.',
          total_clientes_unicos: 0,
          total_conversas: 0,
          total_mensagens: data.total_mensagens_analisadas || 0,
          ranking_por_atendente: rank.map((r) => ({
            usuario_id: r.usuario_id,
            nome: r.nome,
            nota_cordialidade: r.nota_cordialidade,
            total_mensagens_analisadas: r.total_mensagens_analisadas,
          })),
          distincao_entidades: 'Ranking de atendentes por nota heurística de cordialidade textual no período.',
        }
        break
      }
      case 'ANALISE_TOM_ATENDENTE': {
        const am = data.amostra || []
        bloco = {
          clientes_unicos: [],
          clientes_detalhes: [],
          conversas_encontradas: [...new Set(am.map((m) => m.conversa_id).filter(Boolean))],
          conversas_detalhes: [],
          mensagens_encontradas: am.map((m) => m.mensagem_id).filter(Boolean),
          mensagens_detalhes: 'Amostra de mensagens outbound para análise de tom.',
          total_clientes_unicos: 0,
          total_conversas: [...new Set(am.map((m) => m.conversa_id).filter(Boolean))].length,
          total_mensagens: am.length,
          distincao_entidades: 'Amostra para avaliação de tom; não representa todo o volume do período.',
        }
        break
      }
      case 'RELATORIO_ATENDENTE_COMPLETO':
        bloco = resumoOperacionalRelatorio(data)
        break
      default:
        bloco = {
          clientes_unicos: [],
          clientes_detalhes: [],
          conversas_encontradas: [],
          conversas_detalhes: [],
          mensagens_encontradas: [],
          mensagens_detalhes: null,
          total_clientes_unicos: 0,
          total_conversas: 0,
          total_mensagens: 0,
          distincao_entidades: 'Intent sem agregação específica; use campos nativos de Dados.',
        }
    }
  } catch (_) {
    bloco = {
      clientes_unicos: [],
      clientes_detalhes: [],
      conversas_encontradas: [],
      conversas_detalhes: [],
      mensagens_encontradas: [],
      mensagens_detalhes: null,
      total_clientes_unicos: 0,
      total_conversas: 0,
      total_mensagens: 0,
      distincao_entidades: 'Erro ao montar resumo operacional; use Dados legados.',
    }
  }

  const instrucao_para_modelo = buildInstrucaoContagensParaModelo(bloco, foco, question, intent)

  return {
    ...data,
    resumo_operacional_ia: {
      ...bloco,
      periodo_efetivo_usado,
      foco_sugerido_pela_pergunta: foco,
      filtros_aplicados,
      ambiguidades_detectadas,
      alertas_analiticos,
      instrucao_obrigatoria_sobre_contagens: instrucao_para_modelo || 'Use os totais deste bloco; não confunda cliente com conversa nem conversa com mensagem.',
    },
  }
}

function sanearRespostaContagensInconsistentes(answer, intent, data) {
  if (!answer || typeof answer !== 'string') return answer
  const r = data?.resumo_operacional_ia
  if (!r || typeof r !== 'object') return answer
  const tc = Number(r.total_clientes_unicos)
  const tm = Number(r.total_mensagens)
  const tconv = Number(r.total_conversas)
  const extras = []
  const intentsOk = [
    'MENSAGENS_USUARIO_CLIENTE',
    'CONVERSAS_USUARIO_CLIENTE',
    'HISTORICO_CLIENTE',
    'HISTORICO_ATENDENTE',
    'DETALHES_CONVERSA',
    'BUSCA_CONTEUDO_MENSAGENS',
    'CLIENTES_POR_TEMA_FINANCEIRO',
    'CONVERSAS_POR_ASSUNTO_OPERACIONAL',
    'SINAIS_INTERESSE_COMPRA',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ATENDIMENTOS_TRANSFERIDOS',
    'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE',
    'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR',
  ]
  if (!intentsOk.includes(intent)) return answer

  if (tc > 1 && /\b(um único|somente um|apenas um|foi um cliente|era um cliente)\b/i.test(answer)) {
    extras.push(`**Verificação:** Os dados indicam ${tc} clientes distintos (resumo_operacional_ia.total_clientes_unicos).`)
  }
  if (tconv > 1 && /\b(uma única conversa|somente uma conversa|foi uma conversa)\b/i.test(answer)) {
    extras.push(`**Verificação:** Os dados indicam ${tconv} conversas (resumo_operacional_ia.total_conversas).`)
  }
  if (tm > 5 && /\b(apenas uma mensagem|somente uma mensagem|uma mensagem\b)\b/i.test(answer) && !String(answer).includes(String(tm))) {
    extras.push(`**Verificação:** O total de mensagens/evidências no período é ${tm}.`)
  }
  if (!extras.length) return answer
  return `${answer.trim()}\n\n${extras.join('\n')}`
}

function attachAnaliticaUiMeta(data, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const { intent, days, periodoDefinidoNoBody, periodoFixadoNaPergunta } = ctx
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
    periodo_definido_na_requisicao: periodoDefinidoNoBody === true || periodoFixadoNaPergunta === true,
    periodo_padrao_usado: periodoDefinidoNoBody !== true && periodoFixadoNaPergunta !== true,
    periodo_efetivo_consulta: data.periodo_efetivo_consulta || null,
    fonte_dados: data.fonte || inferFonteDados(intent),
    alertas,
    recorte_mensagens: data.recorte_temporal || null,
    texto_cabecalho_periodo: data.recorte_temporal?.texto_cabecalho_ui || null,
    evidencias_colapso_inicial: 6,
    totais_operacionais: data.resumo_operacional_ia
      ? {
          total_clientes_unicos: data.resumo_operacional_ia.total_clientes_unicos,
          total_conversas: data.resumo_operacional_ia.total_conversas,
          total_mensagens: data.resumo_operacional_ia.total_mensagens,
        }
      : null,
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

  const bodyPeriodInformado = period_days != null && Number.isFinite(Number(period_days))
  const tscope = resolveTemporalAnalyticsScope(question, cls)
  const periodDaysNum = bodyPeriodInformado ? Number(period_days) : null
  const intentsComHistoricoAtendente = new Set([
    'HISTORICO_ATENDENTE',
    'RELATORIO_ATENDENTE_COMPLETO',
    'ANALISE_TOM_ATENDENTE',
    'TEMPO_MEDIO_ATENDENTE',
  ])
  const ignorarPeriodBodyPadrao =
    intentsComHistoricoAtendente.has(cls.intent)
    && bodyPeriodInformado
    && tscope?.fixado_na_pergunta !== true
    && periodDaysNum != null
    && periodDaysNum <= 1
  const periodoDefinidoNoBody = bodyPeriodInformado && !ignorarPeriodBodyPadrao

  let days = clampDays((periodoDefinidoNoBody ? periodDaysNum : undefined) ?? cls.period_days ?? 7)
  if (tscope?.opts?.periodo_mensagens_inicio_iso && tscope.opts.periodo_mensagens_fim_exclusive_iso) {
    const ms = Date.parse(tscope.opts.periodo_mensagens_fim_exclusive_iso) - Date.parse(tscope.opts.periodo_mensagens_inicio_iso)
    days = Math.min(365, Math.max(1, Math.ceil(ms / 86400000)))
  }
  const optsPeriodoApi = {
    periodo_solicitado_explicitamente: periodoDefinidoNoBody || tscope?.fixado_na_pergunta === true,
    ...(tscope?.opts || {}),
  }
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
      data = await qTempoMedioRespostaAtendente(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'ANALISE_TOM_ATENDENTE':
      data = await qAmostraTextosAtendente(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'TOP_ATENDENTES_POR_CONVERSAS':
      data = await qTopAtendentesPorConversas(company_id, days, 5)
      break

    case 'CLIENTES_MAIS_ATIVOS':
      data = await qClientesMaisAtivos(company_id, days, 20)
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
        days,
        optsPeriodoApi
      )
      break

    case 'CONVERSAS_USUARIO_CLIENTE':
      data = await qConversasUsuarioCliente(
        company_id,
        cls.usuario_nome || null,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days,
        optsPeriodoApi
      )
      break

    case 'HISTORICO_CLIENTE':
      data = await qHistoricoCliente(
        company_id,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days,
        optsPeriodoApi
      )
      break

    case 'HISTORICO_ATENDENTE':
      data = await qHistoricoAtendente(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'DETALHES_CONVERSA':
      data = await qDetalhesConversa(
        company_id,
        cls.cliente_nome || null,
        cls.cliente_telefone || null,
        days,
        optsPeriodoApi
      )
      break

    case 'RANKING_TEMPO_RESPOSTA_ATENDENTES':
      data = await qRankingTempoRespostaAtendentes(company_id, days, 15)
      break

    case 'BUSCA_CONTEUDO_MENSAGENS': {
      const optsBusca = { ...optsPeriodoApi }
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
      data = await qClientesPorTemaFinanceiro(company_id, days, cls.data_referencia_iso || null, optsPeriodoApi)
      break

    case 'CONVERSAS_POR_ASSUNTO_OPERACIONAL':
      data = await qConversasPorAssuntoOperacional(
        company_id,
        cls.termos_busca || [],
        days,
        cls.data_referencia_iso || null,
        optsPeriodoApi
      )
      break

    case 'ATENDENTE_MAIS_MENSAGENS_COM_TEMA':
      data = await qAtendentesMaisMensagensComTema(company_id, cls.termos_busca || [], days, optsPeriodoApi)
      break

    case 'RANKING_EDUCACAO_ATENDENTES':
      data = await qRankingEducacaoAtendentes(company_id, days, optsPeriodoApi)
      break

    case 'QUALIDADE_ATENDIMENTOS_RANKING':
      data = await qQualidadeAtendimentosRanking(company_id, days)
      break

    case 'SINAIS_INTERESSE_COMPRA':
      data = await qSinaisInteresseCompra(company_id, days, optsPeriodoApi)
      break

    case 'ATENDIMENTOS_LINGUAGEM_PROBLEMA':
      data = await qAtendimentosLinguagemProblema(company_id, days)
      break

    case 'RELATORIO_ATENDENTE_COMPLETO':
      data = await qRelatorioAtendenteCompleto(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'ATENDIMENTOS_TRANSFERIDOS':
      data = await qAtendimentosTransferidosPeriodo(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'CLIENTES_MENSAGEM_SEM_RESPOSTA_ATENDENTE':
      data = await qClientesMensagemSemRespostaAtendente(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    case 'MENSAGENS_ENVIADAS_ATENDENTE_AUTOR':
      data = await qMensagensEnviadasAutorAtendente(company_id, cls.usuario_nome || null, days, optsPeriodoApi)
      break

    default:
      data = null
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data = await attachResumoOperacionalParaIa(company_id, data, cls.intent, {
      question,
      optsPeriodoApi,
      tscope,
      periodoDefinidoNoBody,
      days,
    })
    data = attachAnaliticaUiMeta(data, {
      intent: cls.intent,
      days,
      periodoDefinidoNoBody,
      periodoFixadoNaPergunta: tscope?.fixado_na_pergunta === true,
    })
  }

  let answer = await formatAnswer({ intent: cls.intent, data, question })
  answer = sanearRespostaContradicaoMetricas(answer, cls.intent, data)
  answer = sanearNegacaoComEvidenciaMensagens(answer, cls.intent, data)
  answer = sanearLinguagemTemporalIndevida(answer, cls.intent, data)
  answer = sanearRespostaContagensInconsistentes(answer, cls.intent, data)

  return { ok: true, intent: cls.intent, answer, data }
}

module.exports = { answerDashboardQuestion }
