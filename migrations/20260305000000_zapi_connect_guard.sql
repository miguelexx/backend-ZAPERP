-- Guard para throttling do fluxo "Conectar WhatsApp" (QR Code).
-- Evita loop de chamadas /qr-code/image sem leitura do usuário.

CREATE TABLE IF NOT EXISTS public.zapi_connect_guard (
  company_id    integer PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  last_qr_at    timestamp with time zone,
  qr_attempts   integer NOT NULL DEFAULT 0,
  blocked_until  timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_zapi_connect_guard_blocked 
  ON public.zapi_connect_guard(blocked_until) 
  WHERE blocked_until IS NOT NULL;
