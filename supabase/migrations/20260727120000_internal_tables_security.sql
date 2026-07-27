-- Hardening das tabelas internas acessadas exclusivamente pelo backend.
-- O backend usa SUPABASE_SERVICE_ROLE_KEY; clientes anon/authenticated não
-- precisam de acesso direto a locks, configurações, consumos ou histórico.

ALTER TABLE IF EXISTS public.scheduler_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.atendimento_limits_company_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.atendimento_limits_user_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.atendimento_limits_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.atendimento_limits_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.scheduler_locks FROM anon, authenticated;
REVOKE ALL ON TABLE public.atendimento_limits_company_configs FROM anon, authenticated;
REVOKE ALL ON TABLE public.atendimento_limits_user_configs FROM anon, authenticated;
REVOKE ALL ON TABLE public.atendimento_limits_consumptions FROM anon, authenticated;
REVOKE ALL ON TABLE public.atendimento_limits_history FROM anon, authenticated;

GRANT ALL ON TABLE public.scheduler_locks TO service_role;
GRANT ALL ON TABLE public.atendimento_limits_company_configs TO service_role;
GRANT ALL ON TABLE public.atendimento_limits_user_configs TO service_role;
GRANT ALL ON TABLE public.atendimento_limits_consumptions TO service_role;
GRANT ALL ON TABLE public.atendimento_limits_history TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.atendimento_limits_user_configs_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.atendimento_limits_consumptions_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.atendimento_limits_history_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.atendimento_limits_validate_and_consume(
  integer,
  integer,
  integer,
  text,
  text,
  timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.atendimento_limits_validate_and_consume(
  integer,
  integer,
  integer,
  text,
  text,
  timestamptz
) TO service_role;
