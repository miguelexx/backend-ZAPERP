-- =============================================================================
-- Rodar NO Supabase (SQL Editor) ANTES de testar de novo o alerta do admin.
-- Ajuste company_id se não for 1.
-- =============================================================================

-- 1) Corrigir schema (erro "column criado_em does not exist" / índice quebrado)
ALTER TABLE public.admin_atendimento_alerta_envios
  ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_admin_alerta_envios_company_criado
  ON public.admin_atendimento_alerta_envios (company_id, criado_em DESC);

-- 2) Limpar bloqueio de "já tentou hoje" (idempotência) — senão o job não reenvia no mesmo dia.
--    Só apaga registros da empresa de teste. Remova o bloco se quiser manter histórico.
DELETE FROM public.admin_atendimento_alerta_envios
WHERE company_id = 1;

-- Se preferir apagar só o dia corrente (UTC do servidor Postgres), use em vez do DELETE acima:
-- DELETE FROM public.admin_atendimento_alerta_envios
-- WHERE company_id = 1 AND dia_local = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date;

-- 3) (Opcional) No servidor, para ver no log por que não disparou: ADMIN_ATENDIMENTO_ALERTA_DEBUG=1 no .env e reiniciar.
-- 4) (Opcional) Ver estado da config na empresa 1
-- SELECT config->'admin_atendimento_alerta' FROM public.ia_config WHERE company_id = 1;
