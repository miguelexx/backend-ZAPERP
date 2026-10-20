-- =============================================================================
-- COMPANY_31_1_SIMULAR.sql   (SO LEITURA -- nao altera nada)
-- =============================================================================
-- Relatorio do que a limpeza da empresa 31 vai apagar e do que vai manter.
--
-- Use este arquivo DUAS vezes:
--   ANTES  do COMPANY_31_2_APAGAR.sql -> confira a coluna APAGAR
--   DEPOIS do COMPANY_31_2_APAGAR.sql -> toda linha APAGAR deve ter sumido;
--                                        so devem sobrar linhas MANTER
--
-- E um unico SELECT. Nao tem DO block, nao tem dollar-quote: o SQL Editor do
-- Supabase nao consegue quebrar no lugar errado.
--
-- Para outra empresa: troque o 31 em `cfg` (aparece uma vez so).
-- =============================================================================

WITH cfg AS (
  SELECT
    31::integer AS company,
    ARRAY[
      -- --- NUNCA REMOVER: quebra login, acesso ou a conexao do WhatsApp -----
      'empresas',
      'usuarios',                    -- os atendentes
      'departamentos',
      'usuario_departamentos',
      'usuario_permissoes',
      'usuario_whatsapp_instances',
      'whatsapp_instances',          -- apagar = cai o numero
      'empresa_zapi',
      -- --- CONFIGURACAO DA EMPRESA (comente a linha para zerar tambem) ------
      'configuracoes_operacionais',
      'ia_config',
      'regras_automaticas',
      'respostas_salvas',
      'tags',                        -- catalogo; conversa_tags SAI com as conversas
      'departamento_grupos',
      'empresa_pix_config',
      'disparo_empresa_config',
      'whapi_triage_config',
      'whapi_triage_options',
      'wm_orcamento_integracoes',
      -- --- PUSH DOS ATENDENTES ----------------------------------------------
      'push_subscriptions',
      'push_tokens'
    ]::text[] AS manter
),

-- Toda tabela de public com company_id --------------------------------------
tabelas AS (
  SELECT
    c.table_name::text AS tabela,
    CASE WHEN c.table_name = ANY (cfg.manter) THEN 'MANTER' ELSE 'APAGAR' END AS acao,
    cfg.company
  FROM cfg
  JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.column_name  = 'company_id'
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name   = c.table_name
   AND t.table_type   = 'BASE TABLE'
),
contagem_tabelas AS (
  SELECT
    acao,
    tabela,
    'company_id'::text AS via,
    (xpath(
      '/row/c/text()',
      query_to_xml(
        format('SELECT count(*) AS c FROM public.%I WHERE company_id = %s', tabela, company),
        false, true, '')
    ))[1]::text::bigint AS linhas
  FROM tabelas
),

-- Filhas SEM company_id, presas por FK NO ACTION/RESTRICT a um pai que sai ---
orfas AS (
  SELECT DISTINCT
    cf.relname::text AS filha,
    af.attname::text AS col_filha,
    cp.relname::text AS pai,
    ap.attname::text AS col_pai,
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
    AND con.confdeltype IN ('a', 'r')      -- sem CASCADE: trava o pai
    AND cf.relname <> cp.relname
    AND cf.relname <> ALL (cfg.manter)
    AND cp.relname <> ALL (cfg.manter)
    AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name   = cf.relname
            AND c.column_name  = 'company_id')
    AND EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name   = cp.relname
            AND c.column_name  = 'company_id')
),
contagem_orfas AS (
  SELECT
    'APAGAR'::text AS acao,
    filha          AS tabela,
    ('FK -> ' || pai || '.' || col_pai)::text AS via,
    (xpath(
      '/row/c/text()',
      query_to_xml(
        format(
          'SELECT count(*) AS c FROM public.%I f WHERE f.%I IN '
          '(SELECT p.%I FROM public.%I p WHERE p.company_id = %s)',
          filha, col_filha, col_pai, pai, company),
        false, true, '')
    ))[1]::text::bigint AS linhas
  FROM orfas
)

SELECT acao, tabela, via, linhas
FROM (
  SELECT * FROM contagem_tabelas
  UNION ALL
  SELECT * FROM contagem_orfas
) x
WHERE linhas > 0
ORDER BY acao, linhas DESC, tabela;
