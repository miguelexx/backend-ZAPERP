-- Permissoes Supabase para vinculo de grupos por departamento.
-- O backend usa service_role via PostgREST; tabelas novas precisam de GRANT explicito.

GRANT ALL ON TABLE public.departamento_grupos TO postgres, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'departamento_grupos_id_seq'
      AND c.relkind = 'S'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.departamento_grupos_id_seq TO postgres, service_role';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.validate_departamento_grupos_company_group() TO postgres, service_role;
