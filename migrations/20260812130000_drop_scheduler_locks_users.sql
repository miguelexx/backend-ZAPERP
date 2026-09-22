-- =====================================================
-- Remove tabelas legadas sem uso (verificado em 2026-08-12).
--
--  - public.scheduler_locks: orfa. Zero referencia em codigo/migrations/schema/docs;
--    o lock em uso e public.sync_locks. 0 linhas, sem dependencias.
--  - public.users: espelho antigo de auth.users de um design inicial. O backend usa
--    public.usuarios (nao ha nenhum .from('users')). 0 linhas, nenhuma FK aponta
--    para ela e nenhum trigger em auth.users a popula (confirmado por SELECT).
--
-- DROP sem CASCADE de proposito: se houver dependencia inesperada, falha e avisa
-- em vez de apagar objetos em cascata.
-- =====================================================

BEGIN;

DROP TABLE IF EXISTS public.scheduler_locks;
DROP TABLE IF EXISTS public.users;

COMMIT;
