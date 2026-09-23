-- =====================================================
-- "Aguardar cliente" com PRAZO (alarme) + etiquetas automáticas por tempo.
--
-- O botão "Aguardar cliente" passa a abrir um alarme: o atendente escolhe por
-- quanto tempo vai aguardar. Um scheduler monitora o tempo e aplica etiquetas
-- coloridas conforme o prazo (dentro do prazo / atrasado / sem resposta).
--
-- Colunas NOVAS e independentes do fluxo de ausência legado
-- (aguardando_cliente_desde é deliberadamente mantida a NULL nesse estado —
-- ver conversaStatusManualService). Não reutilizamos aquela coluna para não
-- reativar o job de ausência.
--
--   aguardando_cliente_prazo_desde   quando o alarme começou (relógio da espera)
--   aguardando_cliente_prazo_ate     quando o prazo escolhido vence
--   aguardando_cliente_prazo_origem  origem do prazo (1h,2h,4h,hoje,amanha,data)
--   aguardando_cliente_nivel         nível de etiqueta já aplicado (idempotência
--                                    do monitor): null | aguardando | atrasado | sem_resposta
--
-- Idempotente. Aplicar ANTES do deploy do backend.
-- =====================================================

BEGIN;

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS aguardando_cliente_prazo_desde  timestamptz,
  ADD COLUMN IF NOT EXISTS aguardando_cliente_prazo_ate    timestamptz,
  ADD COLUMN IF NOT EXISTS aguardando_cliente_prazo_origem text,
  ADD COLUMN IF NOT EXISTS aguardando_cliente_nivel        text;

COMMENT ON COLUMN public.conversas.aguardando_cliente_prazo_desde IS
  'Início do alarme "Aguardar cliente" (relógio da espera). Independente de aguardando_cliente_desde.';
COMMENT ON COLUMN public.conversas.aguardando_cliente_prazo_ate IS
  'Prazo escolhido no alarme "Aguardar cliente"; ao vencer, o monitor escala a etiqueta e notifica.';
COMMENT ON COLUMN public.conversas.aguardando_cliente_prazo_origem IS
  'Origem do prazo do alarme: 1h, 2h, 4h, hoje, amanha, data (auditoria).';
COMMENT ON COLUMN public.conversas.aguardando_cliente_nivel IS
  'Nível de etiqueta automática já aplicado pelo monitor: null | aguardando | atrasado | sem_resposta.';

-- Monitor: varre conversas aguardando_cliente com alarme ativo.
CREATE INDEX IF NOT EXISTS idx_conversas_aguardando_cliente_prazo
  ON public.conversas (aguardando_cliente_prazo_ate)
  WHERE status_atendimento = 'aguardando_cliente'::text
    AND aguardando_cliente_prazo_desde IS NOT NULL;

-- Limpeza: conversas que saíram de aguardando_cliente mas ainda têm alarme/etiqueta.
CREATE INDEX IF NOT EXISTS idx_conversas_aguardando_cliente_cleanup
  ON public.conversas (company_id)
  WHERE aguardando_cliente_prazo_desde IS NOT NULL;

COMMIT;
