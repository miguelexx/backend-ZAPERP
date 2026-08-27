-- Versao para aplicar manualmente em producao grande, uma instrucao por vez.
-- CREATE INDEX CONCURRENTLY nao pode rodar dentro de transaction block.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_telefone_trgm
  ON public.clientes USING gin (telefone gin_trgm_ops);
