-- Versao para aplicar manualmente em producao grande, uma instrucao por vez.
-- CREATE INDEX CONCURRENTLY nao pode rodar dentro de transaction block.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_telefone_trgm
  ON public.conversas USING gin (telefone gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_nome_contato_cache_trgm
  ON public.conversas USING gin (nome_contato_cache gin_trgm_ops);
