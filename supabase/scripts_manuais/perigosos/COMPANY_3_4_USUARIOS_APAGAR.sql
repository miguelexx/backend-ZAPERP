-- =============================================================================
-- COMPANY_3_4_USUARIOS_APAGAR.sql     *** APAGA DADOS -- NAO TEM UNDO ***
-- =============================================================================
-- Remove os atendentes da empresa 3, EXCETO os ids de `v_manter_ids`
-- (hoje: 76 = Matheus, matheus@wmsistemas.com).
--
-- Resolve o erro que o editor de tabelas do Supabase da ao tentar excluir as
-- linhas na mao:
--   "Unable to delete rows as one of them is currently referenced by a foreign
--    key constraint from the table atendimentos"
-- O editor nao sabe desfazer os vinculos; este script desfaz, em uma
-- transacao so.
--
-- NAO e migration. Nao roda automaticamente. Rodar no SQL Editor do Supabase.
--
-- -----------------------------------------------------------------------------
-- O QUE ELE FAZ COM CADA TABELA QUE APONTA PARA `usuarios`
-- -----------------------------------------------------------------------------
-- Sao 60+ FKs apontando para `usuarios` -- nao da para lista fixa. O script
-- varre `pg_constraint` e trata cada FK de coluna unica conforme a coluna:
--
--   coluna ACEITA NULL  -> UPDATE ... SET coluna = NULL
--      A linha filha SOBREVIVE, so perde o vinculo (ex.: conversas.atendente_id,
--      mensagens.autor_usuario_id, atendimentos.para_usuario_id). Preserva
--      historico em vez de apagar conteudo que voce nao pediu para apagar.
--
--   coluna NOT NULL     -> DELETE da linha filha
--      A linha nao existe sem o usuario (ex.: usuario_permissoes,
--      usuario_departamentos, push_tokens). So apaga linha da empresa 3 ou sem
--      `company_id`; linha de OUTRA empresa nunca e apagada aqui.
--
-- Se sobrar alguma linha NOT NULL de outra empresa apontando para um usuario
-- removido (vazamento cross-tenant), o DELETE final falha e a transacao inteira
-- volta atras, com a mensagem do Postgres dizendo qual constraint travou.
--
-- -----------------------------------------------------------------------------
-- ORDEM OBRIGATORIA
-- -----------------------------------------------------------------------------
--   1. Snapshot/backup do banco.
--   2. Rodar COMPANY_3_3_USUARIOS_SIMULAR.sql e conferir:
--      - a linha MANTER e o usuario certo (#76 Matheus);
--      - as linhas APAGAR sao os 15 que voce quer tirar;
--      - o que vai virar SET NULL / APAGAR LINHA.
--   3. Rodar ESTE arquivo (o bloco inteiro de uma vez).
--   4. Rodar COMPANY_3_3_USUARIOS_SIMULAR.sql de novo: so pode sobrar MANTER.
--
-- RECOMENDADO: rodar o COMPANY_3_2_APAGAR.sql (zera o historico) ANTES deste.
-- Com conversas/mensagens/atendimentos ja fora, sobra muito menos coisa para
-- desvincular -- o `UPDATE ... SET NULL` em `mensagens.autor_usuario_id` pode
-- ser lento se a tabela ainda estiver cheia.
--
-- -----------------------------------------------------------------------------
-- DEPOIS DE RODAR
-- -----------------------------------------------------------------------------
-- - Reinicie a API (`pm2 restart`). Sessao JWT de usuario apagado continua
--   valida ate expirar: nao ha revogacao de token no sistema. Se algum desses
--   atendentes estiver logado agora, ele segue usando o app ate o token
--   vencer -- se isso for problema, desative o usuario (`ativo = false`) e
--   espere o vencimento antes de apagar.
-- - Conversas que ficaram sem `atendente_id` aparecem como nao atribuidas.
-- =============================================================================

DO $$
DECLARE
  -- ---------------------------------------------------------------- CONFIG --
  v_company integer := 3;

  -- Usuarios que FICAM (precisam ser da empresa acima, senao aborta).
  -- Hoje: 76 = Matheus (matheus@wmsistemas.com).
  v_manter_ids integer[] := ARRAY[76];

  -- -------------------------------------------------------------------------
  r          record;
  v_alvo     integer[];
  v_n        bigint;
  v_apagou   bigint := 0;
  v_nulou    bigint := 0;
  v_sobrou   bigint;
  v_id       integer;
  v_passo    integer;
  v_pendente boolean;
  v_ultima   text;
  v_erro     text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = v_company) THEN
    RAISE EXCEPTION
      'Empresa % nao existe -- abortado para evitar mexer na empresa errada', v_company;
  END IF;

  -- Todo id preservado tem que ser da empresa alvo (pega engano de digitacao).
  FOREACH v_id IN ARRAY v_manter_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.usuarios u WHERE u.id = v_id AND u.company_id = v_company
    ) THEN
      RAISE EXCEPTION
        'Usuario % nao existe ou nao e da empresa % -- confira v_manter_ids', v_id, v_company;
    END IF;
  END LOOP;

  SELECT array_agg(u.id ORDER BY u.id) INTO v_alvo
  FROM public.usuarios u
  WHERE u.company_id = v_company
    AND NOT (u.id = ANY (v_manter_ids));

  IF v_alvo IS NULL THEN
    RAISE NOTICE 'Nada a fazer: empresa % nao tem usuario fora de v_manter_ids.', v_company;
    RETURN;
  END IF;

  RAISE NOTICE 'Removendo % usuario(s) da empresa %: %',
    array_length(v_alvo, 1), v_company, v_alvo;

  -- ========================================================================
  -- Desfaz os vinculos de toda FK de coluna unica que aponta para usuarios.
  -- Ate 6 passadas: linha filha que tiver neta propria so sai depois que a
  -- neta sair (ex.: helpdesk_tickets -> helpdesk_mensagens).
  -- ========================================================================
  FOR v_passo IN 1..6 LOOP
  v_pendente := false;

  FOR r IN
    SELECT DISTINCT
      cf.relname AS filha,
      af.attname AS col,
      af.attnotnull AS obrigatorio,
      EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name   = cf.relname
          AND c.column_name  = 'company_id') AS tem_company
    FROM pg_constraint con
    JOIN pg_class     cu ON cu.oid = con.confrelid   AND cu.relname = 'usuarios'
    JOIN pg_namespace nu ON nu.oid = cu.relnamespace AND nu.nspname = 'public'
    JOIN pg_class     cf ON cf.oid = con.conrelid    AND cf.relkind = 'r'
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace AND nf.nspname = 'public'
    JOIN pg_attribute af ON af.attrelid = con.conrelid AND af.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
    ORDER BY cf.relname, af.attname
  LOOP
    IF r.obrigatorio THEN
      -- Coluna NOT NULL: a linha nao sobrevive sem o usuario -> apaga.
      -- Nunca apaga linha de outra empresa.
      BEGIN
        EXECUTE format(
          'DELETE FROM public.%I f WHERE f.%I = ANY (%L::integer[])%s',
          r.filha, r.col, v_alvo,
          CASE WHEN r.tem_company
               THEN format(' AND (f.company_id IS NULL OR f.company_id = %s)', v_company)
               ELSE '' END);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
          v_apagou := v_apagou + v_n;
          RAISE NOTICE 'passada % | apagou   | %.% | % linhas', v_passo, r.filha, r.col, v_n;
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          v_pendente := true;      -- neta ainda nao saiu; repete na proxima
          v_ultima   := r.filha || '.' || r.col;
          v_erro     := SQLERRM;
      END;
    ELSE
      -- Coluna aceita NULL: preserva a linha, so solta o vinculo.
      EXECUTE format(
        'UPDATE public.%I f SET %I = NULL WHERE f.%I = ANY (%L::integer[])',
        r.filha, r.col, r.col, v_alvo);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        v_nulou := v_nulou + v_n;
        RAISE NOTICE 'passada % | set null | %.% | % linhas', v_passo, r.filha, r.col, v_n;
      END IF;
    END IF;
  END LOOP;

  EXIT WHEN NOT v_pendente;
  END LOOP;

  IF v_pendente THEN
    RAISE EXCEPTION
      'FK ainda bloqueando apos 6 passadas (ultima: %) -- nada foi apagado (rollback). Postgres disse: %',
      COALESCE(v_ultima, '?'), COALESCE(v_erro, '?');
  END IF;

  -- ========================================================================
  -- Agora sim, os usuarios.
  -- ========================================================================
  BEGIN
    DELETE FROM public.usuarios u WHERE u.id = ANY (v_alvo);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION
        'Ainda ha linha apontando para usuario removido -- provavelmente de OUTRA empresa (cross-tenant) ou FK composta. Nada foi apagado (rollback). Postgres disse: %',
        SQLERRM;
  END;

  IF v_n <> array_length(v_alvo, 1) THEN
    RAISE EXCEPTION
      'Esperava remover % usuario(s), removeu % -- nada foi apagado (rollback)',
      array_length(v_alvo, 1), v_n;
  END IF;

  SELECT count(*) INTO v_sobrou
  FROM public.usuarios u
  WHERE u.company_id = v_company
    AND NOT (u.id = ANY (v_manter_ids));

  IF v_sobrou > 0 THEN
    RAISE EXCEPTION
      'Sobraram % usuario(s) da empresa % -- nada foi apagado (rollback)', v_sobrou, v_company;
  END IF;

  RAISE NOTICE 'OK: % usuario(s) removido(s) da empresa %. % linhas filhas apagadas, % vinculos zerados. Preservados: %',
    array_length(v_alvo, 1), v_company, v_apagou, v_nulou, v_manter_ids;
END
$$;
