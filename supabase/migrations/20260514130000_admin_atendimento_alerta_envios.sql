-- Idempotência do job de alerta diário (resumo) por empresa + dia local + horário configurado.
-- Evita envio duplicado se o cron rodar várias vezes na mesma janela.

CREATE TABLE IF NOT EXISTS public.admin_atendimento_alerta_envios (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES public.empresas (id) ON DELETE CASCADE,
  dia_local DATE NOT NULL,
  horario_slot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL DEFAULT false,
  erro TEXT,
  telefone_mascarado TEXT,
  metricas JSONB
);

COMMENT ON TABLE public.admin_atendimento_alerta_envios IS 'Registro de envios do alerta automático de resumo ao administrador (idempotência por slot).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_atendimento_alerta_envios_slot
  ON public.admin_atendimento_alerta_envios (company_id, dia_local, horario_slot);

CREATE INDEX IF NOT EXISTS idx_admin_atendimento_alerta_envios_company_created
  ON public.admin_atendimento_alerta_envios (company_id, created_at DESC);
