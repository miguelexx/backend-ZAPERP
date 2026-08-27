-- Busca da LISTAGEM de clientes (tela Configurações → Clientes) sem acento — ZapERP
--
-- O GET /clientes montava um .or() ILIKE cru em nome/pushname/telefone/observacoes,
-- que NÃO passa por unaccent: "João" não era encontrado por "joao" no servidor
-- (o filtro local do front só reordena o que o servidor já devolveu).
--
-- Esta RPC casa CLIENTES por nome/pushname/telefone/observacoes ignorando acentos e
-- maiúsculas, retornando TODAS as colunas que a tela usa + o total real (count over
-- window), para o backend preencher X-Total-Count sem uma segunda query.
--
-- Reaproveita unaccent_lower(text) e os índices GIN funcionais de nome/pushname
-- (20260810200000) + o índice de telefone (20260827120000).
--
-- Isolamento rígido por company_id (SERVICE_ROLE bypassa RLS).

BEGIN;

CREATE OR REPLACE FUNCTION buscar_clientes_listagem(
  p_company_id      bigint,
  p_termo           text,
  p_phone_variacoes text[]  DEFAULT NULL,
  p_limit           int     DEFAULT 5000,
  p_offset          int     DEFAULT 0
)
RETURNS TABLE (
  id             bigint,
  telefone       text,
  wa_id          text,
  nome           text,
  pushname       text,
  observacoes    text,
  foto_perfil    text,
  email          text,
  empresa        text,
  ultimo_contato text,
  criado_em      text,
  total          bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    cl.id::bigint,
    cl.telefone::text,
    cl.wa_id::text,
    cl.nome::text,
    cl.pushname::text,
    cl.observacoes::text,
    cl.foto_perfil::text,
    cl.email::text,
    cl.empresa::text,
    cl.ultimo_contato::text,
    cl.criado_em::text,
    count(*) OVER()::bigint AS total
  FROM   clientes cl
  WHERE  cl.company_id = p_company_id
    AND  (
           unaccent_lower(cl.nome)        ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR unaccent_lower(cl.pushname)    ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR unaccent_lower(cl.observacoes) ILIKE '%' || unaccent_lower(p_termo) || '%'
        OR cl.telefone                    ILIKE '%' || p_termo || '%'
        OR (
             p_phone_variacoes IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM   unnest(p_phone_variacoes) v(phone)
               WHERE  cl.telefone ILIKE '%' || v.phone || '%'
             )
           )
         )
  ORDER BY cl.id DESC
  LIMIT  p_limit
  OFFSET p_offset;
$$;

GRANT EXECUTE ON FUNCTION buscar_clientes_listagem(bigint, text, text[], int, int)
  TO service_role, authenticated, anon;

COMMIT;
