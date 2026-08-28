-- Nomes vinculados ao mesmo contato (irmãos que compartilham o telefone do responsável).
-- ZapERP: um cliente e uma conversa por telefone. Estes registros só existem para
-- localizar a conversa pelo nome dos demais alunos. Origem exclusiva: importação
-- por planilha com o switch explícito. Isolamento por company_id na aplicação.
--
-- Reverso (seguro; não apaga clientes nem conversas):
--   CREATE OR REPLACE das RPCs abaixo com o corpo de
--     20260823230000_chat_search_word_prefix.sql e
--     20260827121000_clientes_listagem_unaccent_rpc.sql
--   DROP TABLE IF EXISTS public.cliente_nomes_vinculados;

BEGIN;

CREATE TABLE IF NOT EXISTS public.cliente_nomes_vinculados (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id integer NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  nome text NOT NULL,
  nome_normalizado text NOT NULL,
  serie text,
  origem text NOT NULL DEFAULT 'planilha',
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cliente_nomes_vinculados_origem_chk CHECK (origem = 'planilha'),
  CONSTRAINT cliente_nomes_vinculados_nome_chk CHECK (btrim(nome) <> ''),
  CONSTRAINT cliente_nomes_vinculados_unique UNIQUE (company_id, cliente_id, nome_normalizado)
);

COMMENT ON TABLE public.cliente_nomes_vinculados IS
  'Nomes extras do mesmo cliente (ex.: irmãos no telefone do responsável). Só a importação por planilha grava. Não cria contato nem conversa.';
COMMENT ON COLUMN public.cliente_nomes_vinculados.nome_normalizado IS
  'Equivalente a search_name_key(nome): minúsculas, sem acento, pontuação como espaço. Usado no UNIQUE e na busca por prefixo de palavra.';
COMMENT ON COLUMN public.cliente_nomes_vinculados.origem IS
  'Sempre planilha. Webhook, sync e cadastro manual não inserem nesta tabela.';

CREATE INDEX IF NOT EXISTS idx_cliente_nomes_vinculados_lookup
  ON public.cliente_nomes_vinculados (company_id, cliente_id);

CREATE INDEX IF NOT EXISTS idx_cliente_nomes_vinculados_search_prefix
  ON public.cliente_nomes_vinculados (company_id, nome_normalizado text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_cliente_nomes_vinculados_nome_trgm
  ON public.cliente_nomes_vinculados USING gin (nome_normalizado gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cliente_nomes_vinculados
  TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.cliente_nomes_vinculados_id_seq
  TO service_role, authenticated;

-- EXISTS (não JOIN) para não duplicar ids na paginação.

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
             OR EXISTS (
                  SELECT 1
                  FROM   cliente_nomes_vinculados nv
                  WHERE  nv.company_id = p_company_id
                    AND  nv.cliente_id = cl.id
                    AND  (
                           nv.nome_normalizado LIKE t.name_pattern || '%'
                        OR nv.nome_normalizado LIKE '% ' || t.name_pattern || '%'
                         )
                )
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
             OR EXISTS (
                  SELECT 1
                  FROM   cliente_nomes_vinculados nv
                  WHERE  nv.company_id = p_company_id
                    AND  nv.cliente_id = cl.id
                    AND  (
                           nv.nome_normalizado LIKE t.name_pattern || '%'
                        OR nv.nome_normalizado LIKE '% ' || t.name_pattern || '%'
                         )
                )
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
        OR EXISTS (
             SELECT 1
             FROM   cliente_nomes_vinculados nv
             WHERE  nv.company_id = p_company_id
               AND  nv.cliente_id = cl.id
               AND  (
                      unaccent_lower(nv.nome) ILIKE '%' || unaccent_lower(p_termo) || '%'
                   OR nv.nome_normalizado     ILIKE '%' || unaccent_lower(p_termo) || '%'
                    )
           )
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
