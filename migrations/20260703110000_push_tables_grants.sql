-- Corrige "permission denied" em push_subscriptions e push_inbound_delivery_log.
-- Diagnóstico (2026-07-03): as tabelas EXISTEM em produção, mas o role service_role
-- (usado pelo backend via PostgREST/Kong) não recebeu GRANT — foram criadas fora do
-- fluxo padrão de migrations do Supabase. push_tokens funciona porque tem os grants.
-- GRANTs são idempotentes: reexecutar não causa erro nem efeito colateral.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_inbound_delivery_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_inbound_delivery_log_id_seq TO service_role;

-- PostgREST precisa recarregar o schema cache após mudanças de permissão.
NOTIFY pgrst, 'reload schema';
