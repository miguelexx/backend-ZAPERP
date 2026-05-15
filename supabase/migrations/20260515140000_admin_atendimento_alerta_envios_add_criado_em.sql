-- Reparação: tabela criada sem coluna criado_em (CREATE TABLE IF NOT EXISTS não recria a tabela).
-- Seguro em produção: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.admin_atendimento_alerta_envios
  ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_admin_alerta_envios_company_criado
  ON public.admin_atendimento_alerta_envios (company_id, criado_em DESC);
