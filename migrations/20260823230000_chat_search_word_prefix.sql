-- Busca da lista de conversas por prefixo de nome/palavra.
--
-- Antes, o padrão %termo% fazia "hu" casar no meio de S-hu-arts,
-- C-hu-rrascaria e Bic-hu-etti. A chave abaixo transforma pontuação em
-- separador e a consulta só aceita o início do nome ou de uma palavra.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION search_name_key(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT regexp_replace(btrim(unaccent_lower($1)), '[^[:alnum:]]+', ' ', 'g')
$$;

GRANT EXECUTE ON FUNCTION search_name_key(text) TO service_role, authenticated, anon;

-- GIN cobre prefixos de palavras com 3+ caracteres; os índices compostos
-- btree aceleram o caso mais frequente de primeiras letras do nome por tenant.
CREATE INDEX IF NOT EXISTS idx_clientes_nome_search_key_trgm
  ON clientes USING gin (search_name_key(nome) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clientes_pushname_search_key_trgm
  ON clientes USING gin (search_name_key(pushname) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_conversas_nome_cache_search_key_trgm
  ON conversas USING gin (search_name_key(nome_contato_cache) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_conversas_nome_grupo_search_key_trgm
  ON conversas USING gin (search_name_key(nome_grupo) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clientes_company_nome_search_prefix
  ON clientes (company_id, search_name_key(nome) text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_conversas_company_nome_cache_search_prefix
  ON conversas (company_id, search_name_key(nome_contato_cache) text_pattern_ops);

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
  WITH term AS (
    SELECT NULLIF(like_escape(search_name_key(p_termo)), '') AS name_pattern,
           like_escape(p_termo)                              AS raw_pattern
  )
  SELECT c.id
  FROM   conversas c
  CROSS JOIN term t
  WHERE  c.company_id = p_company_id
    AND  t.name_pattern IS NOT NULL
    AND  (
           search_name_key(c.nome_contato_cache) LIKE t.name_pattern || '%'
        OR search_name_key(c.nome_contato_cache) LIKE '% ' || t.name_pattern || '%'
        OR search_name_key(c.nome_grupo)         LIKE t.name_pattern || '%'
        OR search_name_key(c.nome_grupo)         LIKE '% ' || t.name_pattern || '%'
         )

  UNION

  SELECT c.id
  FROM   conversas c
  JOIN   clientes cl ON cl.id = c.cliente_id AND cl.company_id = p_company_id
  CROSS JOIN term t
  WHERE  c.company_id = p_company_id
    AND  (
           (t.name_pattern IS NOT NULL AND (
                search_name_key(cl.nome)     LIKE t.name_pattern || '%'
             OR search_name_key(cl.nome)     LIKE '% ' || t.name_pattern || '%'
             OR search_name_key(cl.pushname) LIKE t.name_pattern || '%'
             OR search_name_key(cl.pushname) LIKE '% ' || t.name_pattern || '%'
           ))
        OR cl.telefone ILIKE '%' || t.raw_pattern || '%'
        OR (
             p_phone_variacoes IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM unnest(p_phone_variacoes) v(phone)
               WHERE cl.telefone ILIKE '%' || like_escape(v.phone) || '%'
             )
           )
         )
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION buscar_conversas_por_nome_ids(bigint, text, text[], int)
  TO service_role, authenticated, anon;

CREATE OR REPLACE FUNCTION buscar_clientes_por_nome_telefone(
  p_company_id      bigint,
  p_termo           text,
  p_phone_variacoes text[]  DEFAULT NULL,
  p_limit           int     DEFAULT 150
)
RETURNS TABLE (
  id          bigint,
  nome        text,
  pushname    text,
  telefone    text,
  foto_perfil text
)
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER SET search_path = public
AS $$
  WITH term AS (
    SELECT NULLIF(like_escape(search_name_key(p_termo)), '') AS name_pattern,
           like_escape(p_termo)                              AS raw_pattern
  )
  SELECT cl.id, cl.nome, cl.pushname, cl.telefone, cl.foto_perfil
  FROM   clientes cl
  CROSS JOIN term t
  WHERE  cl.company_id = p_company_id
    AND  (
           (t.name_pattern IS NOT NULL AND (
                search_name_key(cl.nome)     LIKE t.name_pattern || '%'
             OR search_name_key(cl.nome)     LIKE '% ' || t.name_pattern || '%'
             OR search_name_key(cl.pushname) LIKE t.name_pattern || '%'
             OR search_name_key(cl.pushname) LIKE '% ' || t.name_pattern || '%'
           ))
        OR cl.telefone ILIKE '%' || t.raw_pattern || '%'
        OR (
             p_phone_variacoes IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM unnest(p_phone_variacoes) v(phone)
               WHERE cl.telefone ILIKE '%' || like_escape(v.phone) || '%'
             )
           )
         )
  ORDER BY
    CASE
      WHEN t.name_pattern IS NOT NULL AND search_name_key(cl.nome) LIKE t.name_pattern || '%' THEN 0
      WHEN t.name_pattern IS NOT NULL AND search_name_key(cl.pushname) LIKE t.name_pattern || '%' THEN 1
      ELSE 2
    END,
    cl.nome ASC NULLS LAST
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION buscar_clientes_por_nome_telefone(bigint, text, text[], int)
  TO service_role, authenticated, anon;

COMMIT;
