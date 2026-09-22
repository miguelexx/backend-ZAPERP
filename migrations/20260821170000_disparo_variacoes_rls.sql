-- Correção de auditoria Etapa 4: RLS em disparo_campanha_variacoes
-- Mesmo padrão das tabelas das Etapas 1–3: RLS ligado, só service_role.

ALTER TABLE public.disparo_campanha_variacoes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.disparo_campanha_variacoes FROM anon, authenticated;
GRANT ALL ON public.disparo_campanha_variacoes TO service_role;

COMMENT ON TABLE public.disparo_campanha_variacoes IS
  'Variações de mensagem por campanha. RLS habilitado; isolamento multi-tenant via company_id no backend (service_role).';
