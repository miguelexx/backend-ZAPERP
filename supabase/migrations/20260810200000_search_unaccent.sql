-- Busca sem acento para ZapERP
-- Habilita unaccent + pg_trgm, cria wrapper IMMUTABLE, índices funcionais e RPC de busca.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Wrapper IMMUTABLE necessário para uso em índices funcionais.
-- unaccent() em si é IMMUTABLE no Postgres 14+, mas o wrapper explícito
-- garante que o planner aceite a expressão em GIN indexes sem reclamação.
CREATE OR REPLACE FUNCTION unaccent_lower(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT lower(unaccent($1)) $$;

GRANT EXECUTE ON FUNCTION unaccent_lower(text) TO service_role, authenticated, anon;

-- Índices funcionais em clientes (nome e pushname sem acento)
CREATE INDEX IF NOT EXISTS idx_clientes_nome_unaccent_trgm
  ON clientes USING gin (unaccent_lower(nome) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_clientes_pushname_unaccent_trgm
  ON clientes USING gin (unaccent_lower(pushname) gin_trgm_ops);

-- Índices funcionais em conversas (nome_contato_cache e nome_grupo sem acento)
CREATE INDEX IF NOT EXISTS idx_conversas_nome_contato_cache_unaccent_trgm
  ON conversas USING gin (unaccent_lower(nome_contato_cache) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_conversas_nome_grupo_unaccent_trgm
  ON conversas USING gin (unaccent_lower(nome_grupo) gin_trgm_ops);

-- RPC: busca unificada de conversas por nome/cliente com suporte a acentos e variantes de telefone.
--
-- Substitui as 3 queries sequenciais/paralelas separadas que o backend fazia:
--   (1) await clientes by nome/pushname  →  convByCliente
--   (2) conversas.nome_contato_cache     →  convByNomeContatoCache
--   (3) conversas.nome_grupo             →  convByNomeGrupo
--
-- Parâmetros:
--   p_company_id      : empresa (obrigatório)
--   p_termo           : texto bruto digitado pelo usuário (sem wildcards)
--   p_phone_variacoes : variantes numéricas do telefone geradas pelo JS (opcional)
--   p_limit           : máximo de IDs a retornar
--
-- Retorna SETOF bigint (conversa.id), deduplicated via UNION.
CREATE OR REPLACE FUNCTION buscar_conversas_por_nome_ids(
  p_company_id      bigint,
  p_termo           text,
  p_phone_variacoes text[]  DEFAULT NULL,
  p_limit           int     DEFAULT 1000
)
RETURNS SETOF bigint
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER SET search_path = public
AS $$
  -- (A) nome_contato_cache ou nome_grupo da conversa (com unaccent)
  SELECT id
  FROM   conversas
  WHERE  company_id = p_company_id
    AND  (
           unaccent_lower(nome_contato_cache) ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR unaccent_lower(nome_grupo)         ILIKE '%' || unaccent_lower(p_termo) || '%'
         )

  UNION

  -- (B) nome, pushname ou telefone do cliente vinculado (com unaccent no nome)
  SELECT c.id
  FROM   conversas  c
  JOIN   clientes   cl ON cl.id = c.cliente_id AND cl.company_id = p_company_id
  WHERE  c.company_id = p_company_id
    AND  (
           unaccent_lower(cl.nome)     ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR unaccent_lower(cl.pushname) ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR cl.telefone                 ILIKE '%' || p_termo || '%'
        OR (
             p_phone_variacoes IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM   unnest(p_phone_variacoes) v(phone)
               WHERE  cl.telefone ILIKE '%' || v.phone || '%'
             )
           )
         )

  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION buscar_conversas_por_nome_ids(bigint, text, text[], int) TO service_role, authenticated, anon;

COMMIT;
