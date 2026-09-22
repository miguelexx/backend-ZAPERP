-- Finalização automática por ausência do cliente (backend-only)
-- Mantém compatibilidade: status_atendimento continua usando valores existentes.

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS finalizacao_motivo text,
  ADD COLUMN IF NOT EXISTS finalizada_automaticamente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finalizada_automaticamente_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS aguardando_cliente_desde timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ausencia_mensagem_enviada_em timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_conversas_absencia_scan
  ON public.conversas (company_id, status_atendimento, atendente_id, aguardando_cliente_desde, finalizada_automaticamente_em);

CREATE INDEX IF NOT EXISTS idx_conversas_finalizacao_motivo
  ON public.conversas (company_id, finalizacao_motivo);
