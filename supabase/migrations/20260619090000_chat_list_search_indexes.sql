-- Acelera busca da lista de conversas por telefone e nome exibido em cache.
-- Nao altera dados nem regras de atendimento; apenas apoia ILIKE usado em GET /chats.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_conversas_telefone_trgm
  ON public.conversas USING gin (telefone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_conversas_nome_contato_cache_trgm
  ON public.conversas USING gin (nome_contato_cache gin_trgm_ops);
