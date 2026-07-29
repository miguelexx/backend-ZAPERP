-- Financeiro: fluxo de cobrança (pagamento pendente / em atraso) — isolado dos demais setores.

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

COMMENT ON CONSTRAINT conversas_status_atendimento_check ON public.conversas IS
  'Inclui pagamento_pendente e em_atraso: fluxo exclusivo do setor Financeiro (cobrança com prazo).';

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS pagamento_prazo_ate timestamptz,
  ADD COLUMN IF NOT EXISTS pagamento_prazo_origem text;

COMMENT ON COLUMN public.conversas.pagamento_prazo_ate IS
  'Prazo acordado em Aguardar pagamento; ao vencer, job pode mover para em_atraso.';
COMMENT ON COLUMN public.conversas.pagamento_prazo_origem IS
  'Origem do prazo: hoje, amanha, 4h, data (auditoria).';

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_prazo_vencido
  ON public.conversas (company_id, pagamento_prazo_ate)
  WHERE status_atendimento = 'pagamento_pendente'::text;

CREATE INDEX IF NOT EXISTS idx_conversas_pagamento_pendente_lista
  ON public.conversas (company_id, status_atendimento, atendente_id)
  WHERE status_atendimento IN ('pagamento_pendente'::text, 'em_atraso'::text);
