-- Backup da flag de reaberta por falta de interação (funciona mesmo sem coluna em conversas)

ALTER TABLE public.alerta_atendimento_sem_resposta_estado
  ADD COLUMN IF NOT EXISTS reaberta_em TIMESTAMPTZ;

COMMENT ON COLUMN public.alerta_atendimento_sem_resposta_estado.reaberta_em IS
  'Momento em que a conversa foi reaberta pelo alerta sem resposta; limpo ao assumir.';
