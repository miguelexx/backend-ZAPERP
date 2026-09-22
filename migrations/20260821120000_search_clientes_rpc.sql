-- Busca de clientes por nome/telefone (base da empresa) sem acento — ZapERP
--
-- Complementa 20260810200000_search_unaccent.sql: aquela RPC casa CONVERSAS por
-- nome/telefone; esta casa CLIENTES diretamente (inclusive os SEM conversa), para
-- que a busca da tela de conversas encontre qualquer cliente da empresa por nome
-- ou telefone, ignorando maiúsculas/minúsculas e acentos, sem depender de o
-- cliente possuir conversa ou mensagens.
--
-- Reaproveita unaccent_lower(text) e os índices GIN funcionais em
-- clientes.nome / clientes.pushname criados na migration de 2026-08-10.

BEGIN;

-- Parâmetros:
--   p_company_id      : empresa (obrigatório) — isolamento rígido por id_company
--   p_termo           : texto bruto digitado (sem wildcards)
--   p_phone_variacoes : variantes numéricas do telefone geradas pelo JS (opcional)
--   p_limit           : máximo de clientes a retornar
CREATE OR REPLACE FUNCTION buscar_clientes_por_nome_telefone(
  p_company_id      bigint,
  p_termo           text,
  p_phone_variacoes text[]  DEFAULT NULL,
  p_limit           int     DEFAULT 150
)
RETURNS TABLE (
  id         bigint,
  nome       text,
  pushname   text,
  telefone   text,
  foto_perfil text
)
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT cl.id, cl.nome, cl.pushname, cl.telefone, cl.foto_perfil
  FROM   clientes cl
  WHERE  cl.company_id = p_company_id
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
  ORDER BY cl.nome ASC NULLS LAST
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION buscar_clientes_por_nome_telefone(bigint, text, text[], int)
  TO service_role, authenticated, anon;

COMMIT;
