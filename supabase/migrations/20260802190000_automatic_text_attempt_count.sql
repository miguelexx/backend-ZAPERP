-- Limita o reenvio seguro de textos automáticos cuja primeira tentativa ficou incerta.
ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS provider_attempt_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.mensagens.provider_attempt_count IS
  'Quantidade de POSTs ao provedor para esta linha; evita reenvios automáticos ilimitados.';
