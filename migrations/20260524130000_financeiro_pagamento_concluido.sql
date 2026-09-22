-- Etiqueta "Pagamento concluído" após confirmar cobrança (enquanto em_atendimento; limpa ao encerrar).

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS pagamento_concluido_em timestamptz;

COMMENT ON COLUMN public.conversas.pagamento_concluido_em IS
  'Preenchido ao confirmar pagamento (Pagamento concluído). Exibe badge discreto em em_atendimento; limpo ao encerrar ou nova cobrança.';

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_concluido_lista
  ON public.conversas (company_id, atendente_id)
  WHERE pagamento_concluido_em IS NOT NULL
    AND status_atendimento = 'em_atendimento'::text;
