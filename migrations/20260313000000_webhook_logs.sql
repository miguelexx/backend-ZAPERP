-- =====================================================
-- Sistema de Log para Webhooks
-- Registra todos os webhooks recebidos (UltraMsg, Meta)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id bigserial PRIMARY KEY,
  provider varchar(30) NOT NULL,
  path varchar(255) NOT NULL,
  method varchar(10) NOT NULL DEFAULT 'POST',
  instance_id varchar(64),
  company_id integer REFERENCES public.empresas(id) ON DELETE SET NULL,
  event_type varchar(100),
  status varchar(50) NOT NULL,
  payload jsonb DEFAULT '{}',
  ip varchar(45),
  user_agent text,
  response_status integer,
  response_body jsonb,
  error_message text,
  processing_ms integer,
  criado_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider ON public.webhook_logs(provider);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_company ON public.webhook_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_instance ON public.webhook_logs(instance_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_criado ON public.webhook_logs(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON public.webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON public.webhook_logs(event_type);

COMMENT ON TABLE public.webhook_logs IS 'Log completo de todos os webhooks recebidos (UltraMsg, Meta) para auditoria e diagnóstico';
