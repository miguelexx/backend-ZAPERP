-- =============================================================================
-- COMPANY_19_1_SIMULAR.sql   (SO LEITURA -- nao altera nada)
-- =============================================================================
-- Relatorio do que a limpeza da empresa 19 vai apagar e do que vai manter.
--
-- ESCOPO: zera o HISTORICO/dados operacionais (conversas, mensagens, clientes,
-- atendimentos, logs, disparos, helpdesk, chat interno, auditoria) e PRESERVA
-- os atendentes (`usuarios`), o acesso deles, a conexao de WhatsApp
-- (`whatsapp_instances`) e a configuracao da empresa.
--
-- Use este arquivo DUAS vezes:
--   ANTES  do COMPANY_19_2_APAGAR.sql -> confira o NOME da empresa (primeira
--                                       linha, acao = EMPRESA) e a coluna
--                                       APAGAR
--   DEPOIS do COMPANY_19_2_APAGAR.sql -> toda linha APAGAR deve ter sumido;
--                                       so devem sobrar linhas MANTER
--
-- Se a primeira linha vier '*** NAO EXISTE ***', pare: o id esta errado e voce
-- ia apagar dados da empresa errada.
--
-- A lista `manter` aqui tem que ser IGUAL a `v_manter` do
-- COMPANY_19_2_APAGAR.sql -- se mudar aqui, mude la tambem, senao o relatorio
-- deixa de bater com a exclusao. Para zerar tambem uma dessas tabelas,
-- comente a linha nos DOIS arquivos.
--
-- E um unico SELECT. Nao tem DO block, nao tem dollar-quote: o SQL Editor do
-- Supabase nao consegue quebrar no lugar errado.
--
-- Para outra empresa: troque o 19 em `cfg` (aparece uma vez so).
-- =============================================================================

WITH cfg AS (
  SELECT
    19::integer AS company,
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
      'ia_config',                   -- chatbot / menu
      'regras_automaticas',
      'respostas_salvas',
      'tags',                        -- catalogo; conversa_tags SAI com as conversas
      'departamento_grupos',
      'empresa_pix_config',
      'disparo_empresa_config',
      'whapi_triage_config',
      'whapi_triage_options',
      'wm_orcamento_integracoes',    -- credenciais da integracao WM
      -- --- PUSH DOS ATENDENTES ----------------------------------------------
      'push_subscriptions',
      'push_tokens'
    ]::text[] AS manter
),

-- Identificacao da empresa: confira o nome antes de apagar -------------------
empresa_alvo AS (
  SELECT
    0 AS ord,
    'EMPRESA'::text AS acao,
    ('id=' || cfg.company)::text AS tabela,
    COALESCE(
      (SELECT COALESCE(e.nome, '(sem nome)')
                || CASE WHEN e.ativo IS FALSE THEN ' (inativa)' ELSE ' (ativa)' END
         FROM public.empresas e WHERE e.id = cfg.company),
      '*** NAO EXISTE -- NAO RODE O APAGAR ***'
    )::text AS via,
    (SELECT count(*) FROM public.empresas e WHERE e.id = cfg.company)::bigint AS linhas
  FROM cfg
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
    1 AS ord,
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

-- Filhas presas por FK NO ACTION/RESTRICT a um pai que sai --------------------
-- Inclui filha SEM company_id (sai inteira pelo vinculo) e filha COM
-- company_id cuja linha esta orfa (NULL) ou e de outra empresa apontando para
-- registro desta -- essas nao sao pegas pelo filtro company_id e travam a FK.
orfas AS (
  SELECT DISTINCT
    cf.relname::text AS filha,
    af.attname::text AS col_filha,
    cp.relname::text AS pai,
    ap.attname::text AS col_pai,
    EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = cf.relname
        AND c.column_name  = 'company_id') AS filha_tem_company,
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
    AND EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name   = cp.relname
            AND c.column_name  = 'company_id')
),
contagem_orfas AS (
  SELECT
    1 AS ord,
    'APAGAR'::text AS acao,
    filha          AS tabela,
    ('FK -> ' || pai || '.' || col_pai
       || CASE WHEN filha_tem_company THEN ' (orfas/cross-tenant)' ELSE '' END)::text AS via,
    (xpath(
      '/row/c/text()',
      query_to_xml(
        format(
          'SELECT count(*) AS c FROM public.%I f WHERE f.%I IN '
          '(SELECT p.%I FROM public.%I p WHERE p.company_id = %s)%s',
          filha, col_filha, col_pai, pai, company,
          CASE WHEN filha_tem_company
               THEN format(' AND (f.company_id IS NULL OR f.company_id <> %s)', company)
               ELSE '' END),
        false, true, '')
    ))[1]::text::bigint AS linhas
  FROM orfas
)

SELECT acao, tabela, via, linhas
FROM (
  SELECT * FROM empresa_alvo
  UNION ALL
  SELECT * FROM contagem_tabelas
  UNION ALL
  SELECT * FROM contagem_orfas
) x
WHERE ord = 0 OR linhas > 0
ORDER BY ord, acao, linhas DESC, tabela;
