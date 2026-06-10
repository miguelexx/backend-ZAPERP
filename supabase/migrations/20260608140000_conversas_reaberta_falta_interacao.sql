-- Badge na lista: conversa reaberta automaticamente por falta de resposta do atendente

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS reaberta_falta_interacao_em TIMESTAMPTZ;

COMMENT ON COLUMN public.conversas.reaberta_falta_interacao_em IS
  'Preenchido quando o alerta sem resposta reabre a conversa; limpo ao assumir ou encerrar.';

CREATE INDEX IF NOT EXISTS idx_conversas_reaberta_falta_interacao
  ON public.conversas (company_id, reaberta_falta_interacao_em DESC NULLS LAST)
  WHERE reaberta_falta_interacao_em IS NOT NULL;
