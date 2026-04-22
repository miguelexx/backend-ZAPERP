-- Status manual "aguardando_cliente" (espera intencional do atendente — fora da fila de ausência automática).
-- Alinha CHECK com valores já usados no app (incl. finalizada).

ALTER TABLE public.conversas DROP CONSTRAINT IF EXISTS conversas_status_atendimento_check;

ALTER TABLE public.conversas ADD CONSTRAINT conversas_status_atendimento_check
  CHECK (status_atendimento = ANY (ARRAY[
    'aberta'::text,
    'em_atendimento'::text,
    'aguardando_cliente'::text,
    'fechada'::text,
    'finalizada'::text
  ]));

COMMENT ON CONSTRAINT conversas_status_atendimento_check ON public.conversas IS
  'Inclui aguardando_cliente: pausa manual do atendente (não elegível a encerramento por ausência automática).';
