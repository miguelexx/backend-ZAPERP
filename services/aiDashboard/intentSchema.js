'use strict'

const { z } = require('zod')

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
    'RELATORIO_PRODUTIVIDADE_ATENDENTES', // relatório/planilha CSV de produtividade dos atendentes
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

module.exports = { IntentSchema }
