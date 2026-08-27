-- =========================================================
-- APAGAR_DADOS_COMPANY_4.sql
-- WIPE AMPLO da empresa: conversas, mensagens, clientes, tags,
-- usuarios e departamentos. NÃO use isto só para limpar o chat.
--
-- Para apagar APENAS contatos + conversas + mensagens da empresa 4,
-- use EXCLUIR_TODOS_CLIENTES_COMPANY_4.sql
-- =========================================================

BEGIN;

DO $$
DECLARE
  v_company_id integer := 4;
  r record;
BEGIN
  -- Tabelas sem company_id direto, mas dependentes de conversas/usuarios da empresa
  DELETE FROM public.historico_atendimentos
  WHERE conversa_id IN (
    SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
  )
  OR usuario_id IN (
    SELECT u.id FROM public.usuarios u WHERE u.company_id = v_company_id
  );

  -- Filha de atendimentos/conversas/usuarios/clientes
  DELETE FROM public.avaliacoes_atendimento
  WHERE company_id = v_company_id
     OR atendimento_id IN (
       SELECT a.id
       FROM public.atendimentos a
       WHERE a.company_id = v_company_id
          OR a.conversa_id IN (
            SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
          )
     )
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     )
     OR atendente_id IN (
       SELECT u.id FROM public.usuarios u WHERE u.company_id = v_company_id
     )
     OR cliente_id IN (
       SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id
     );

  -- Filhas de conversas
  DELETE FROM public.atendimentos
  WHERE company_id = v_company_id
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     );

  DELETE FROM public.conversa_unreads
  WHERE company_id = v_company_id
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     );

  DELETE FROM public.mensagens
  WHERE company_id = v_company_id
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     );

  DELETE FROM public.conversa_tags
  WHERE company_id = v_company_id
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     );

  -- Logs vinculados a conversas da empresa
  DELETE FROM public.bot_logs
  WHERE company_id = v_company_id
     OR conversa_id IN (
       SELECT c.id FROM public.conversas c WHERE c.company_id = v_company_id
     );

  -- Conversas e entidades-base da empresa
  DELETE FROM public.conversas
  WHERE company_id = v_company_id;

  -- Filhas de clientes (FK RESTRICT — tem que sair ANTES do DELETE em clientes)
  DELETE FROM public.cliente_tags
  WHERE company_id = v_company_id
     OR cliente_id IN (SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id);

  DELETE FROM public.contato_opt_in
  WHERE company_id = v_company_id
     OR cliente_id IN (SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id);

  DELETE FROM public.contato_opt_out
  WHERE company_id = v_company_id
     OR cliente_id IN (SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id);

  IF to_regclass('public.helpdesk_tickets') IS NOT NULL THEN
    UPDATE public.helpdesk_tickets
    SET cliente_id = NULL
    WHERE company_id = v_company_id
       OR cliente_id IN (SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id);
  END IF;

  IF to_regclass('public.disparo_campanha_destinatarios') IS NOT NULL THEN
    UPDATE public.disparo_campanha_destinatarios
    SET cliente_id = NULL
    WHERE company_id = v_company_id
       OR cliente_id IN (SELECT cl.id FROM public.clientes cl WHERE cl.company_id = v_company_id);
  END IF;

  DELETE FROM public.clientes
  WHERE company_id = v_company_id;

  DELETE FROM public.tags
  WHERE company_id = v_company_id;

  DELETE FROM public.usuarios
  WHERE company_id = v_company_id;

  DELETE FROM public.departamentos
  WHERE company_id = v_company_id;

  -- grupos/comunidades: tabelas legadas removidas (20260413190000); metadados em conversas.

  -- Limpeza complementar: tenta remover em qualquer outra tabela com company_id.
  -- Ignora tabelas já tratadas acima.
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'company_id'
      AND c.table_name NOT IN (
        'atendimentos',
        'conversa_unreads',
        'mensagens',
        'conversa_tags',
        'conversas',
        'clientes',
        'tags',
        'usuarios',
        'departamentos',
        'empresas'
      )
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format(
        'DELETE FROM %I.%I WHERE company_id = $1',
        r.table_schema,
        r.table_name
      )
      USING v_company_id;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel limpar %.%: %',
          r.table_schema, r.table_name, SQLERRM;
    END;
  END LOOP;

  -- Opcional: remover o registro da empresa.
  -- Descomente se quiser deletar tambem a linha em public.empresas.
  -- DELETE FROM public.empresas WHERE id = v_company_id;
END $$;

COMMIT;

-- Verificacao rapida (rode depois):
-- SELECT COUNT(*) AS conversas_restantes FROM public.conversas WHERE company_id = 4;
-- SELECT COUNT(*) AS mensagens_restantes FROM public.mensagens WHERE company_id = 4;
-- SELECT COUNT(*) AS usuarios_restantes  FROM public.usuarios  WHERE company_id = 4;
-- SELECT COUNT(*) AS clientes_restantes  FROM public.clientes  WHERE company_id = 4;
