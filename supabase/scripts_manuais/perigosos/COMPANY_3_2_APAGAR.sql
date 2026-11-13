-- =============================================================================
-- COMPANY_3_2_APAGAR.sql     *** APAGA DADOS -- NAO TEM UNDO ***
-- =============================================================================
-- Zera TODOS os dados operacionais da empresa 3 (conversas, mensagens,
-- clientes/contatos, tags de conversa, atendimentos, historico, avaliacoes,
-- bot/webhook/auditoria logs, disparos, helpdesk, chat interno, unreads)
-- MANTENDO os atendentes (`usuarios`), o acesso deles, a conexao de WhatsApp
-- (`whatsapp_instances`) e a configuracao da empresa (chatbot, respostas
-- salvas, tags, PIX, triagem).
--
-- Mesmo procedimento do COMPANY_31_2_APAGAR.sql, ja parametrizado para a
-- empresa 3. Se o objetivo for DESCONTINUAR a empresa (apagar tambem os
-- atendentes e a conexao), nao use este arquivo assim: esvazie `v_manter`
-- deixando so 'empresas' -- e faca o mesmo em `manter` no 1_SIMULAR.
--
-- NAO e migration. Nao roda automaticamente. Rodar no SQL Editor do Supabase.
--
-- -----------------------------------------------------------------------------
-- ORDEM OBRIGATORIA
-- -----------------------------------------------------------------------------
--   1. Snapshot/backup do banco.
--   2. Rodar COMPANY_3_1_SIMULAR.sql: conferir o NOME da empresa na primeira
--      linha (acao = EMPRESA) e as contagens marcadas APAGAR.
--   3. Rodar ESTE arquivo (o bloco inteiro de uma vez).
--   4. Rodar COMPANY_3_1_SIMULAR.sql de novo: so pode sobrar linha MANTER.
--
-- -----------------------------------------------------------------------------
-- DEPOIS DE RODAR
-- -----------------------------------------------------------------------------
-- - Midia (imagem/audio/documento) fica no R2/Storage. Este script apaga as
--   linhas de `mensagens` (com `storage_key`), mas os ARQUIVOS continuam la.
-- - Reinicie a API (`pm2 restart`) e peca refresh aos atendentes logados:
--   delete direto no banco nao emite evento Socket.IO, o front fica com
--   conversa fantasma em cache ate recarregar.
-- - `disparo_worker_heartbeat` nao tem `company_id` (e global) -- nao e tocado.
-- - A conexao de WhatsApp continua ativa: mensagem nova entra e recria
--   cliente/conversa do zero. Se quiser a empresa parada enquanto limpa,
--   desative a instancia antes.
--
-- -----------------------------------------------------------------------------
-- COMO ELE DECIDE O QUE APAGAR
-- -----------------------------------------------------------------------------
-- Nao tem lista fixa de tabelas. Em tempo de execucao varre o
-- `information_schema` e apaga de TODA tabela de `public` com coluna
-- `company_id`, exceto as de `v_manter` -- entao cobre tambem tabela criada
-- depois deste script, sem precisar edita-lo.
--
-- Filhas SEM `company_id` (ex.: `historico_atendimentos`,
-- `internal_conversation_reads`) saem pelo vinculo de FK com o pai que esta
-- sendo apagado, e so quando a FK e NO ACTION/RESTRICT -- as `ON DELETE
-- CASCADE` se resolvem sozinhas quando o pai sai. Filha presa somente a um pai
-- de `v_manter` (ex.: linha de `historico_atendimentos` sem `conversa_id`, so
-- com `usuario_id`) NAO sai -- o pai nao esta sendo apagado.
--
-- A ETAPA A tambem pega filha que TEM `company_id` mas cuja linha esta ORFA
-- (`company_id` NULL, legado anterior ao hardening multi-tenant) ou e de outra
-- empresa, apontando para um registro desta. Essas linhas nao saem pelo filtro
-- `company_id = 3` da ETAPA B e sao a causa classica do script abortar com
-- `violates foreign key constraint` (visto em `atendimentos`).
--
-- Roda em ate 12 passadas: tabela que falhar por FK e repetida na passada
-- seguinte, depois que as filhas sairem. Nao e preciso acertar ordem na mao.
--
-- ATOMICO: o bloco inteiro e um unico statement, logo uma unica transacao.
-- Se a conferencia final achar sobra, ele levanta excecao e o Postgres
-- desfaz TUDO. Nao ha estado pela metade.
--
-- SE ABORTAR por FK depois das 12 passadas: a mensagem de erro cita a ultima
-- tabela e o erro do Postgres. Causa provavel = linha de OUTRA empresa
-- apontando para registro da empresa 3 (vazamento cross-tenant). Rode
-- ../diagnostico/AUDITAR_ISOLAMENTO_EMPRESAS.sql antes de insistir -- nada
-- foi apagado.
--
-- LIMITE CONHECIDO: a ETAPA A so enxerga filha -> pai direto. Se existir
-- cadeia de DUAS tabelas sem `company_id` (neta -> filha -> pai-com-company_id,
-- todas com FK NO ACTION), a neta trava e o script aborta sem apagar nada --
-- falha segura. Hoje nao existe essa cadeia no schema.
--
-- VOLUME: se `mensagens` da empresa 3 passar de ~500 mil linhas (veja o
-- SIMULAR), rode antes o COMPANY_3_0_MENSAGENS_EM_LOTES.sql para tirar o
-- grosso em lotes commitados -- uma transacao unica com milhoes de linhas
-- segura lock e incha o WAL.
--
-- OBS. DE FORMATO: de proposito, o bloco nao usa dollar-quote nomeado nem
-- parametro posicional (cifrao-um) por dentro -- o SQL Editor do Supabase
-- quebra o statement no lugar errado quando encontra qualquer um dos dois.
-- =============================================================================

DO $$
DECLARE
  -- ---------------------------------------------------------------- CONFIG --
  v_company integer := 3;

  -- Tabelas que NAO serao tocadas (igual a lista `manter` do
  -- COMPANY_3_1_SIMULAR.sql; se mudar aqui, mude la tambem para o relatorio
  -- continuar batendo).
  v_manter text[] := ARRAY[
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
  ];

  -- -------------------------------------------------------------------------
  r          record;
  v_nome     text;
  v_n        bigint;
  v_total    bigint := 0;
  v_pendente boolean;
  v_passo    integer;
  v_resto    text;
  v_ultima   text;
  v_erro     text;
BEGIN
  SELECT e.nome INTO v_nome FROM public.empresas e WHERE e.id = v_company;

  IF v_nome IS NULL THEN
    RAISE EXCEPTION
      'Empresa % nao existe -- abortado para evitar apagar a empresa errada', v_company;
  END IF;

  RAISE NOTICE 'Limpando empresa % (%) -- mantendo atendentes e conexao...',
    v_company, v_nome;

  FOR v_passo IN 1..12 LOOP
    v_pendente := false;

    -- ======================================================================
    -- ETAPA A -- filhas presas por FK a pais que serao apagados.
    -- Somente FK NO ACTION ('a') / RESTRICT ('r'); CASCADE se resolve sozinha.
    -- Cobre dois casos:
    --   1. filha SEM company_id (ex.: historico_atendimentos);
    --   2. filha COM company_id mas com linha ORFA (company_id NULL) ou de
    --      OUTRA empresa apontando para registro desta -- essas nao saem pela
    --      ETAPA B e sao a causa classica de "violates foreign key constraint"
    --      no fim do script (ex.: atendimentos.company_id NULL, legado).
    -- ======================================================================
    FOR r IN
      SELECT DISTINCT
        cf.relname AS filha,
        af.attname AS col_filha,
        cp.relname AS pai,
        ap.attname AS col_pai,
        EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name   = cf.relname
            AND c.column_name  = 'company_id') AS filha_tem_company
      FROM pg_constraint con
      JOIN pg_class     cf ON cf.oid = con.conrelid    AND cf.relkind = 'r'
      JOIN pg_namespace nf ON nf.oid = cf.relnamespace AND nf.nspname = 'public'
      JOIN pg_class     cp ON cp.oid = con.confrelid   AND cp.relkind = 'r'
      JOIN pg_namespace np ON np.oid = cp.relnamespace AND np.nspname = 'public'
      JOIN pg_attribute af ON af.attrelid = con.conrelid  AND af.attnum = con.conkey[1]
      JOIN pg_attribute ap ON ap.attrelid = con.confrelid AND ap.attnum = con.confkey[1]
      WHERE con.contype = 'f'
        AND array_length(con.conkey, 1) = 1
        AND con.confdeltype IN ('a', 'r')
        AND cf.relname <> cp.relname
        AND cf.relname <> ALL (v_manter)
        AND cp.relname <> ALL (v_manter)
        AND EXISTS (
              SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public'
                AND c.table_name   = cp.relname
                AND c.column_name  = 'company_id')
    LOOP
      BEGIN
        -- Filha que TEM company_id: aqui so as linhas orfas (NULL) ou de outra
        -- empresa -- as da empresa alvo saem na ETAPA B, sem contar duas vezes.
        EXECUTE format(
          'DELETE FROM public.%I f WHERE f.%I IN '
          '(SELECT p.%I FROM public.%I p WHERE p.company_id = %s)%s',
          r.filha, r.col_filha, r.col_pai, r.pai, v_company,
          CASE WHEN r.filha_tem_company
               THEN format(' AND (f.company_id IS NULL OR f.company_id <> %s)', v_company)
               ELSE '' END);
        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n > 0 THEN
          v_total := v_total + v_n;
          RAISE NOTICE 'passada % | % | % linhas (via %.%)%',
            v_passo, r.filha, v_n, r.pai, r.col_pai,
            CASE WHEN r.filha_tem_company THEN ' [orfas/cross-tenant]' ELSE '' END;
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          v_pendente := true;      -- repete na proxima passada
          v_ultima   := r.filha;
          v_erro     := SQLERRM;
      END;
    END LOOP;

    -- ======================================================================
    -- ETAPA B -- toda tabela de public com company_id, fora de v_manter.
    -- ======================================================================
    FOR r IN
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
       AND t.table_type   = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name  = 'company_id'
        AND c.table_name  <> ALL (v_manter)
      ORDER BY c.table_name
    LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM public.%I WHERE company_id = %s', r.table_name, v_company);
        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n > 0 THEN
          v_total := v_total + v_n;
          RAISE NOTICE 'passada % | % | % linhas', v_passo, r.table_name, v_n;
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          v_pendente := true;      -- filha ainda nao saiu; repete
          v_ultima   := r.table_name;
          v_erro     := SQLERRM;
      END;
    END LOOP;

    EXIT WHEN NOT v_pendente;
  END LOOP;

  IF v_pendente THEN
    RAISE EXCEPTION
      'FK ainda bloqueando apos 12 passadas (ultima: %) -- nada foi apagado (rollback). Postgres disse: %',
      COALESCE(v_ultima, '?'), COALESCE(v_erro, '?');
  END IF;

  -- ------------------------------------------------------------------------
  -- Conferencia final: nenhuma tabela-alvo pode ter sobrado com linhas.
  -- Se sobrou, excecao -> rollback de tudo.
  -- ------------------------------------------------------------------------
  v_resto := NULL;
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name   = c.table_name
     AND t.table_type   = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name  = 'company_id'
      AND c.table_name  <> ALL (v_manter)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE company_id = %s', r.table_name, v_company)
      INTO v_n;
    IF v_n > 0 THEN
      v_resto := concat_ws(', ', v_resto, r.table_name || '=' || v_n);
    END IF;
  END LOOP;

  IF v_resto IS NOT NULL THEN
    RAISE EXCEPTION
      'Sobraram linhas da empresa % em: % -- nada foi apagado (rollback)', v_company, v_resto;
  END IF;

  RAISE NOTICE 'OK: % linhas apagadas da empresa % (%). Atendentes e conexao preservados.',
    v_total, v_company, v_nome;
END
$$;
