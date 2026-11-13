-- =============================================================================
-- CERTIFICAR_EMPRESA_REMOVIDA.sql   (SO LEITURA -- nao altera nada)
-- =============================================================================
-- Prova que nao sobrou NADA de uma empresa no banco: mensagens, conversas,
-- clientes, atendentes, configuracao, logs, filhas sem `company_id` e a
-- instancia de WhatsApp. Use antes de reaproveitar um canal/numero em outra
-- empresa.
--
-- Resultado VAZIO (fora a linha EMPRESA) = limpo. Qualquer linha `SOBROU`
-- aponta exatamente onde ainda ha dado.
--
-- Rode no SQL Editor do Supabase, NAO pela API: `usuario_permissoes` e
-- `whatsapp_envio_guard_logs` tiveram os grants revogados no hardening
-- multi-tenant e respondem 403 no PostgREST -- pelo SQL Editor sao lidas
-- normalmente.
--
-- Para outra empresa/canal: troque os valores em `cfg` (aparecem uma vez so).
-- =============================================================================

WITH cfg AS (
  SELECT
    20::integer   AS company,          -- id da empresa que deve estar removida
    '553434219570'::text AS telefone,  -- numero do canal (so digitos) ou ''
    'SPDRMN-GV5C4'::text AS canal      -- id/token do canal no provider ou ''
),

-- 1) A empresa ainda existe? ------------------------------------------------
empresa_linha AS (
  SELECT
    0 AS ord,
    CASE WHEN EXISTS (SELECT 1 FROM public.empresas e WHERE e.id = cfg.company)
         THEN 'SOBROU' ELSE 'REMOVIDA' END::text AS situacao,
    'empresas'::text AS tabela,
    COALESCE(
      (SELECT 'id ' || e.id || ' = ' || COALESCE(e.nome, '(sem nome)')
         FROM public.empresas e WHERE e.id = cfg.company),
      'id ' || cfg.company || ' nao existe em empresas'
    )::text AS detalhe,
    (SELECT count(*) FROM public.empresas e WHERE e.id = cfg.company)::bigint AS linhas
  FROM cfg
),

-- 2) Toda tabela com company_id ---------------------------------------------
tabelas AS (
  SELECT c.table_name::text AS tabela, cfg.company
  FROM cfg
  JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.column_name = 'company_id'
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
),
sobras_diretas AS (
  SELECT
    1 AS ord,
    'SOBROU'::text AS situacao,
    tabela,
    'company_id = ' || company AS detalhe,
    (xpath('/row/c/text()', query_to_xml(
      format('SELECT count(*) AS c FROM public.%I WHERE company_id = %s', tabela, company),
      false, true, '')))[1]::text::bigint AS linhas
  FROM tabelas
),

-- 3) Filhas SEM company_id penduradas em pai da empresa ---------------------
orfas AS (
  SELECT DISTINCT
    cf.relname::text AS filha, af.attname::text AS col_filha,
    cp.relname::text AS pai,   ap.attname::text AS col_pai,
    cfg.company
  FROM cfg
  JOIN pg_constraint con ON con.contype = 'f'
  JOIN pg_class     cf ON cf.oid = con.conrelid    AND cf.relkind = 'r'
  JOIN pg_namespace nf ON nf.oid = cf.relnamespace AND nf.nspname = 'public'
  JOIN pg_class     cp ON cp.oid = con.confrelid   AND cp.relkind = 'r'
  JOIN pg_namespace np ON np.oid = cp.relnamespace AND np.nspname = 'public'
  JOIN pg_attribute af ON af.attrelid = con.conrelid  AND af.attnum = con.conkey[1]
  JOIN pg_attribute ap ON ap.attrelid = con.confrelid AND ap.attnum = con.confkey[1]
  WHERE array_length(con.conkey, 1) = 1
    AND cf.relname <> cp.relname
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = cf.relname
                      AND c.column_name = 'company_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = cp.relname
                  AND c.column_name = 'company_id')
),
sobras_filhas AS (
  SELECT
    2 AS ord,
    'SOBROU'::text AS situacao,
    filha AS tabela,
    ('via FK ' || pai || '.' || col_pai) AS detalhe,
    (xpath('/row/c/text()', query_to_xml(
      format('SELECT count(*) AS c FROM public.%I f WHERE f.%I IN '
             '(SELECT p.%I FROM public.%I p WHERE p.company_id = %s)',
             filha, col_filha, col_pai, pai, company),
      false, true, '')))[1]::text::bigint AS linhas
  FROM orfas
),

-- 4) O canal/numero aparece em alguma instancia? ----------------------------
instancias AS (
  SELECT
    3 AS ord,
    'ATENCAO'::text AS situacao,
    'whatsapp_instances'::text AS tabela,
    ('instancia id ' || w.id || ' da empresa ' || w.company_id
       || ' casa com o canal/telefone informado') AS detalhe,
    1::bigint AS linhas
  FROM cfg, public.whatsapp_instances w
  WHERE (cfg.telefone <> '' AND to_jsonb(w)::text LIKE '%' || cfg.telefone || '%')
     OR (cfg.canal    <> '' AND upper(to_jsonb(w)::text) LIKE '%' || upper(cfg.canal) || '%')
),

-- 5) O numero como CONTATO de outras empresas (normal, so informativo) ------
contatos AS (
  SELECT
    4 AS ord,
    'INFO'::text AS situacao,
    'clientes'::text AS tabela,
    ('empresa ' || cl.company_id || ': ' || COALESCE(cl.nome, '(sem nome)')
       || ' -- contato de outra empresa, nao e dado da empresa removida') AS detalhe,
    1::bigint AS linhas
  FROM cfg, public.clientes cl
  WHERE cfg.telefone <> '' AND cl.telefone LIKE '%' || cfg.telefone || '%'
)

SELECT situacao, tabela, detalhe, linhas
FROM (
  SELECT * FROM empresa_linha
  UNION ALL SELECT * FROM sobras_diretas
  UNION ALL SELECT * FROM sobras_filhas
  UNION ALL SELECT * FROM instancias
  UNION ALL SELECT * FROM contatos
) x
WHERE ord = 0 OR linhas > 0
ORDER BY ord, linhas DESC, tabela;
