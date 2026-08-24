-- Produção: mesmos índices da migration 20260823230000, sem bloquear escritas.
-- Execute cada instrução fora de BEGIN/COMMIT. Depois, aplique os dois
-- CREATE OR REPLACE FUNCTION das RPCs presentes na migration correspondente.

CREATE OR REPLACE FUNCTION public.search_name_key(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT regexp_replace(btrim(public.unaccent_lower($1)), '[^[:alnum:]]+', ' ', 'g')
$$;

GRANT EXECUTE ON FUNCTION public.search_name_key(text) TO service_role, authenticated, anon;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_nome_search_key_trgm
  ON public.clientes USING gin (public.search_name_key(nome) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_pushname_search_key_trgm
  ON public.clientes USING gin (public.search_name_key(pushname) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_nome_cache_search_key_trgm
  ON public.conversas USING gin (public.search_name_key(nome_contato_cache) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_nome_grupo_search_key_trgm
  ON public.conversas USING gin (public.search_name_key(nome_grupo) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clientes_company_nome_search_prefix
  ON public.clientes (company_id, public.search_name_key(nome) text_pattern_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_company_nome_cache_search_prefix
  ON public.conversas (company_id, public.search_name_key(nome_contato_cache) text_pattern_ops);
