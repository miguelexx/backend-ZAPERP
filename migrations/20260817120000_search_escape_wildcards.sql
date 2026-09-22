-- Busca por nome/telefone: escapar curingas (% _ \) no termo digitado.
--
-- A RPC buscar_conversas_por_nome_ids monta o padrão ILIKE como
-- '%' || unaccent_lower(p_termo) || '%'. Sem escape, um usuário que digita
-- "50%" ou "a_b" faz o Postgres interpretar % / _ como curinga, retornando
-- matches errados. Aqui o miolo (o termo) passa a ser sempre literal.
--
-- Mantém tudo o que já funciona (unaccent, índices trGM, variantes de telefone).

BEGIN;

-- Escapa os caracteres especiais de LIKE/ILIKE (\ deve vir primeiro).
CREATE OR REPLACE FUNCTION like_escape(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_')
$$;

GRANT EXECUTE ON FUNCTION like_escape(text) TO service_role, authenticated, anon;

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
           unaccent_lower(nome_contato_cache) ILIKE '%' || like_escape(unaccent_lower(p_termo)) || '%'
        OR unaccent_lower(nome_grupo)         ILIKE '%' || like_escape(unaccent_lower(p_termo)) || '%'
         )

  UNION

  -- (B) nome, pushname ou telefone do cliente vinculado (com unaccent no nome)
  SELECT c.id
  FROM   conversas  c
  JOIN   clientes   cl ON cl.id = c.cliente_id AND cl.company_id = p_company_id
  WHERE  c.company_id = p_company_id
    AND  (
           unaccent_lower(cl.nome)     ILIKE '%' || like_escape(unaccent_lower(p_termo)) || '%'
        OR unaccent_lower(cl.pushname) ILIKE '%' || like_escape(unaccent_lower(p_termo)) || '%'
        OR cl.telefone                 ILIKE '%' || like_escape(p_termo) || '%'
        OR (
             p_phone_variacoes IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM   unnest(p_phone_variacoes) v(phone)
               WHERE  cl.telefone ILIKE '%' || like_escape(v.phone) || '%'
             )
           )
         )

  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION buscar_conversas_por_nome_ids(bigint, text, text[], int) TO service_role, authenticated, anon;

COMMIT;
