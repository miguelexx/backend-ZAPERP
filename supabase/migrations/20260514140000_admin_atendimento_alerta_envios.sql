-- Idempotência do job POST /jobs/admin-atendimento-alerta (um registro por empresa e dia local do envio).

CREATE TABLE IF NOT EXISTS public.admin_atendimento_alerta_envios (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES public.empresas (id) ON DELETE CASCADE,
  dia_local date NOT NULL,
  horario_config text NOT NULL DEFAULT '',
  sucesso boolean NOT NULL DEFAULT false,
  destino_suffix text,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_alerta_envios_company_dia_unique UNIQUE (company_id, dia_local)
);

COMMENT ON TABLE public.admin_atendimento_alerta_envios IS
  'Registro diário do alerta de resumo ao administrador (evita reenvio se o cron rodar várias vezes).';

CREATE INDEX IF NOT EXISTS idx_admin_alerta_envios_company_criado
  ON public.admin_atendimento_alerta_envios (company_id, criado_em DESC);
