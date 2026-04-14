-- =============================================================================
-- IA analítica — SQL OPCIONAL (não aplicado automaticamente pelo repositório)
-- Execute manualmente no Supabase após validar impacto em staging.
-- Prioridades alinhadas ao diagnóstico: busca textual, filtros multi-tenant,
-- rankings por período. Ajuste nomes de schema se necessário.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PRIORIDADE ALTA — extensão pg_trgm + índice GIN em mensagens.texto
-- (melhora ILIKE '%termo%' e similaridade; requer: CREATE EXTENSION IF NOT EXISTS pg_trgm;)
-- -----------------------------------------------------------------------------
-- CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- CREATE INDEX IF NOT EXISTS idx_mensagens_company_texto_trgm
--   ON public.mensagens USING gin (texto gin_trgm_ops)
--   WHERE company_id IS NOT NULL AND texto IS NOT NULL AND btrim(texto) <> '';

-- CREATE INDEX IF NOT EXISTS idx_internal_messages_company_content_trgm
--   ON public.internal_messages USING gin (content gin_trgm_ops)
--   WHERE company_id IS NOT NULL AND is_deleted = false AND btrim(content) <> '';

-- -----------------------------------------------------------------------------
-- PRIORIDADE ALTA — janela de tempo + empresa (reduz range scan em relatórios)
-- -----------------------------------------------------------------------------
-- CREATE INDEX IF NOT EXISTS idx_mensagens_company_criado_desc
--   ON public.mensagens (company_id, criado_em DESC);

-- -----------------------------------------------------------------------------
-- PRIORIDADE MÉDIA — avaliações por período e nota
-- -----------------------------------------------------------------------------
-- CREATE INDEX IF NOT EXISTS idx_avaliacoes_company_criado_nota
--   ON public.avaliacoes_atendimento (company_id, criado_em DESC, nota);

-- -----------------------------------------------------------------------------
-- PRIORIDADE MÉDIA — views somente leitura (exemplos; revisar joins reais)
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW public.vw_ai_primeira_resposta_por_conversa AS
-- SELECT
--   m.company_id,
--   m.conversa_id,
--   min(case when m.direcao = 'in' then m.criado_em end) AS primeira_msg_cliente_em,
--   min(case when m.direcao = 'out' and m.criado_em >= (
--         select min(m2.criado_em) from public.mensagens m2
--         where m2.conversa_id = m.conversa_id and m2.direcao = 'in'
--       ) then m.criado_em end) AS primeira_resposta_out_em
-- FROM public.mensagens m
-- GROUP BY m.company_id, m.conversa_id;

-- -----------------------------------------------------------------------------
-- PRIORIDADE FUTURA — tsvector português + unaccent (menos falso positivo que ILIKE)
-- -----------------------------------------------------------------------------
-- Requer extensões unaccent + dicionário português configurado.
-- Depois: coluna gerada search_vector + índice GIN.

-- -----------------------------------------------------------------------------
-- PRIORIDADE FUTURA — pgvector + tabela de embeddings (pipeline assíncrono)
-- -----------------------------------------------------------------------------
