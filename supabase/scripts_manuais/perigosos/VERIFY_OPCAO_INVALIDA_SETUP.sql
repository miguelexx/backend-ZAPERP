-- =====================================================
-- Verificação: RPC opção inválida + reset ao finalizar
-- Rode no Supabase SQL Editor após aplicar os scripts/migrations.
-- =====================================================

-- 1) Função existe (assinatura com 3 argumentos)
SELECT p.oid::regprocedure AS funcao_ok
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'reserve_opcao_invalida_slot';

-- Esperado: uma linha, ex.: reserve_opcao_invalida_slot(bigint,bigint,jsonb)

-- 2) Corpo contém search_path = public (recomendado)
SELECT
  CASE
    WHEN pg_get_functiondef(p.oid) LIKE '%search_path%public%' THEN 'OK: SET search_path = public presente'
    ELSE 'ATENÇÃO: considere adicionar SET search_path = public na função'
  END AS checagem_search_path
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'reserve_opcao_invalida_slot'
LIMIT 1;

-- 3) Permissões de execução (Supabase)
SELECT r.rolname,
       has_function_privilege(
         r.oid,
         'public.reserve_opcao_invalida_slot(bigint,bigint,jsonb)'::regprocedure,
         'EXECUTE'
       ) AS pode_executar
FROM pg_roles r
WHERE r.rolname IN ('service_role', 'authenticated', 'anon', 'postgres')
ORDER BY r.rolname;

-- Esperado: service_role e postgres com pode_executar = true

-- 4) Trigger que zera logs opcao_invalida ao finalizar conversa
SELECT tg.tgname AS trigger_nome,
       p.proname AS funcao_trigger
FROM pg_trigger tg
JOIN pg_class c ON c.oid = tg.tgrelid
JOIN pg_namespace ns ON ns.oid = c.relnamespace
JOIN pg_proc p ON p.oid = tg.tgfoid
WHERE ns.nspname = 'public'
  AND c.relname = 'conversas'
  AND NOT tg.tgisinternal
  AND tg.tgname = 'conversas_reset_opcao_invalida_on_finalize';

-- Esperado: uma linha com trigger conversas_reset_opcao_invalida_on_finalize
-- Se zero linhas: migration 20260409100000_reset_opcao_invalida_on_finalize.sql não foi aplicada

-- 5) Teste manual da RPC (opcional — troque IDs reais; não altera se conversa não existir)
-- SELECT public.reserve_opcao_invalida_slot(
--   1::bigint,
--   999999::bigint,
--   '{"teste":true}'::jsonb
-- );
-- Depois apague o log de teste:
-- DELETE FROM public.bot_logs WHERE conversa_id = 999999 AND tipo = 'opcao_invalida';
