-- Execute APENAS isto no Supabase (SQL Editor) se o RUN_IN_SUPABASE.sql
-- der erro 23505 "clientes_telefone_unique". Depois rode o RUN_IN_SUPABASE.sql de novo.

ALTER TABLE public.clientes
  DROP CONSTRAINT IF EXISTS clientes_telefone_unique;
