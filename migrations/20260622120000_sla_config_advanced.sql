-- SLA avançado: meta percentual, horário comercial, bot, metas por setor/atendente
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS sla_meta_percentual integer DEFAULT 90,
  ADD COLUMN IF NOT EXISTS sla_usar_horario_comercial boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_contar_bot_como_resposta boolean DEFAULT false;

COMMENT ON COLUMN public.empresas.sla_meta_percentual IS 'Meta percentual de cumprimento de SLA (dashboard)';
COMMENT ON COLUMN public.empresas.sla_usar_horario_comercial IS 'Se true, SLA conta apenas minutos dentro do expediente configurado';
COMMENT ON COLUMN public.empresas.sla_contar_bot_como_resposta IS 'Se true, primeira resposta automática/bot conta como resposta válida';

ALTER TABLE public.departamentos
  ADD COLUMN IF NOT EXISTS sla_minutos_sem_resposta integer NULL;

COMMENT ON COLUMN public.departamentos.sla_minutos_sem_resposta IS 'Meta SLA em minutos para o setor (null = herda empresa)';

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS sla_minutos_sem_resposta integer NULL;

COMMENT ON COLUMN public.usuarios.sla_minutos_sem_resposta IS 'Meta SLA em minutos para o atendente (null = herda setor/empresa)';
