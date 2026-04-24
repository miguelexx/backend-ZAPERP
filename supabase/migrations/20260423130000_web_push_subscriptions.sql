-- Web Push (PWA): subscriptions por usuário/empresa + log de deduplicação por mensagem

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_company_user
  ON public.push_subscriptions (company_id, usuario_id);

COMMENT ON TABLE public.push_subscriptions IS 'Endpoints Web Push (VAPID) por atendente; usado para notificar fora do app.';

-- Evita push duplicado ao mesmo usuário para a mesma mensagem (reconnect, re-emit de mídia, etc.)
CREATE TABLE IF NOT EXISTS public.push_inbound_delivery_log (
  id bigserial PRIMARY KEY,
  company_id integer NOT NULL,
  mensagem_id text NOT NULL,
  usuario_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_inbound_delivery_log_uq UNIQUE (mensagem_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_push_inbound_delivery_log_created
  ON public.push_inbound_delivery_log (created_at DESC);

COMMENT ON TABLE public.push_inbound_delivery_log IS 'Dedup de notificações push inbound por mensagem e usuário.';
