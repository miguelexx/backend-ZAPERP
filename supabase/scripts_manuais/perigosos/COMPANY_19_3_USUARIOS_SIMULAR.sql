-- =============================================================================
-- COMPANY_19_3_USUARIOS_SIMULAR.sql   (SO LEITURA -- nao altera nada)
-- =============================================================================
-- Relatorio do que o COMPANY_19_4_USUARIOS_APAGAR.sql vai fazer: quais usuarios
-- da empresa 19 saem, qual fica, e o que acontece com cada tabela que aponta
-- para eles por FK.
--
-- Como ler a coluna `acao`:
--   MANTER       -> usuario preservado (lista `manter_ids`)
--   APAGAR       -> usuario que sera removido
--   SET NULL     -> coluna que ACEITA NULL: a linha filha SOBREVIVE, so perde
--                   o vinculo com o usuario (ex.: conversas.atendente_id)
--   APAGAR LINHA -> coluna NOT NULL: a linha filha nao existe sem o usuario,
--                   entao ela e apagada (ex.: usuario_permissoes)
--
-- Rode ANTES e DEPOIS do COMPANY_19_4_USUARIOS_APAGAR.sql. Depois, so pode
-- sobrar linha MANTER.
--
-- A lista `manter_ids` aqui tem que ser IGUAL a `v_manter_ids` do
-- COMPANY_19_4_USUARIOS_APAGAR.sql.
--
-- E um unico SELECT. Nao tem DO block, nao tem dollar-quote: o SQL Editor do
-- Supabase nao consegue quebrar no lugar errado.
-- =============================================================================

WITH cfg AS (
  SELECT
    19::integer AS company,
    -- Usuarios que FICAM. Hoje: 76 = Matheus (matheus@wmsistemas.com).
    ARRAY[]::integer[] AS manter_ids          -- vazio: APAGAR TODOS
),

-- Um por usuario da empresa -------------------------------------------------
usuarios_rel AS (
  SELECT
    0 AS ord,
    CASE WHEN u.id = ANY (cfg.manter_ids) THEN 'MANTER' ELSE 'APAGAR' END::text AS acao,
    'usuarios'::text AS tabela,
    ('#' || u.id || ' ' || COALESCE(u.nome, '(sem nome)') || ' <' || u.email || '> '
       || u.perfil || CASE WHEN u.ativo IS FALSE THEN ' [inativo]' ELSE '' END)::text AS via,
    1::bigint AS linhas
  FROM cfg
  JOIN public.usuarios u ON u.company_id = cfg.company
),

-- Toda FK de coluna unica apontando para usuarios ---------------------------
fks AS (
  SELECT DISTINCT
    cf.relname::text AS filha,
    af.attname::text AS col,
    af.attnotnull    AS obrigatorio,
    EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = cf.relname
        AND c.column_name  = 'company_id') AS tem_company,
    cfg.company,
    cfg.manter_ids
  FROM cfg
  JOIN pg_constraint con ON con.contype = 'f'
  JOIN pg_class     cu ON cu.oid = con.confrelid   AND cu.relname = 'usuarios'
  JOIN pg_namespace nu ON nu.oid = cu.relnamespace AND nu.nspname = 'public'
  JOIN pg_class     cf ON cf.oid = con.conrelid    AND cf.relkind = 'r'
  JOIN pg_namespace nf ON nf.oid = cf.relnamespace AND nf.nspname = 'public'
  JOIN pg_attribute af ON af.attrelid = con.conrelid AND af.attnum = con.conkey[1]
  WHERE array_length(con.conkey, 1) = 1
),
contagem_fk AS (
  SELECT
    1 AS ord,
    CASE WHEN obrigatorio THEN 'APAGAR LINHA' ELSE 'SET NULL' END::text AS acao,
    filha AS tabela,
    (filha || '.' || col
       || CASE WHEN obrigatorio AND tem_company THEN ' (so company ' || company || '/NULL)' ELSE '' END)::text AS via,
    (xpath(
      '/row/c/text()',
      query_to_xml(
        format(
          'SELECT count(*) AS c FROM public.%I f WHERE f.%I IN '
          '(SELECT u.id FROM public.usuarios u WHERE u.company_id = %s '
          'AND NOT (u.id = ANY (ARRAY[%s]::integer[])))%s',
          filha, col, company, array_to_string(manter_ids, ','),
          CASE WHEN obrigatorio AND tem_company
               THEN format(' AND (f.company_id IS NULL OR f.company_id = %s)', company)
               ELSE '' END),
        false, true, '')
    ))[1]::text::bigint AS linhas
  FROM fks
)

SELECT acao, tabela, via, linhas
FROM (
  SELECT * FROM usuarios_rel
  UNION ALL
  SELECT * FROM contagem_fk
) x
WHERE ord = 0 OR linhas > 0
ORDER BY ord, acao, linhas DESC, tabela;
