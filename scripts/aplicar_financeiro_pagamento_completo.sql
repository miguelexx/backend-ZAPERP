-- Execute no Supabase → SQL Editor (projeto do .env do backend).
-- Idempotente: pode rodar mais de uma vez.

-- 1) Status e prazo de cobrança (se ainda não aplicou 20260524120000)
ALTER TABLE public.conversas DROP CONSTRAINT IF EXISTS conversas_status_atendimento_check;

ALTER TABLE public.conversas ADD CONSTRAINT conversas_status_atendimento_check
  CHECK (status_atendimento = ANY (ARRAY[
    'aberta'::text,
    'em_atendimento'::text,
    'aguardando_cliente'::text,
    'pagamento_pendente'::text,
    'em_atraso'::text,
    'fechada'::text,
    'finalizada'::text,
    'mensagem_disparada'::text
  ]));

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS pagamento_prazo_ate timestamptz,
  ADD COLUMN IF NOT EXISTS pagamento_prazo_origem text;

-- 2) Etiqueta "Pagamento concluído" (20260524130000)
ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS pagamento_concluido_em timestamptz;

COMMENT ON COLUMN public.conversas.pagamento_concluido_em IS
  'Preenchido ao confirmar pagamento; badge em em_atendimento; limpo ao encerrar.';

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_prazo_vencido
  ON public.conversas (company_id, pagamento_prazo_ate)
  WHERE status_atendimento = 'pagamento_pendente'::text;

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_pendente_lista
  ON public.conversas (company_id, status_atendimento, atendente_id)
  WHERE status_atendimento IN ('pagamento_pendente'::text, 'em_atraso'::text);

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_concluido_lista
  ON public.conversas (company_id, atendente_id)
  WHERE pagamento_concluido_em IS NOT NULL
    AND status_atendimento = 'em_atendimento'::text;
